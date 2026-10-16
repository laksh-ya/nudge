// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// @title PolicyVault
/// @notice One vault per person. Holds a single token. AI agents pay saved contacts from it within
/// limits the contract enforces itself; everything else needs the owner's passkey, verified here.
/// @dev No admin and no upgrade path. The guardian (the app's backend) can only tighten: freeze the
/// vault or an agent, or cancel a held payment or a queued change. It can never move money, add an
/// agent, or loosen a limit. Owner actions that loosen anything wait `changeDelay` before they apply.
contract PolicyVault {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    enum Op {
        Pay, //            (address to, uint256 amount, bytes32 paymentId)
        SetAgent, //       (address agent, uint128 perPayment, uint128 dailyCap, uint64 expiresAt)
        RemoveAgent, //    (address agent)
        AddContact, //     (bytes32 contactId, address payee, bool immediate, uint128 dailyCap)  dailyCap 0 = no per-contact cap
        RemoveContact, //  (bytes32 contactId)
        SetPolicy, //      (uint256 protectedAmount, uint256 dailyCeiling, uint64 newContactDelay, uint64 changeDelay, uint256 holdAbove, uint64 holdFor)
        Unfreeze, //       (address agent)  address(0) unfreezes the vault
        AddOwnerKey, //    (bytes32 x, bytes32 y, bytes32 rpIdHash)
        RemoveOwnerKey, // (bytes32 keyId)
        Withdraw, //       (address to, uint256 amount)  the one way below the protected amount
        CancelChange, //   (bytes32 changeId)
        CancelHeld, //     (bytes32 paymentId)
        Batch //           (uint8[] ops, bytes[] datas)  one approval for several changes; no nesting
    }

    /// @notice What the owner's passkey signs. The challenge is `digest(action)`.
    struct Action {
        Op op;
        bytes data;
        uint256 nonce;
        uint64 deadline;
    }

    struct OwnerKey {
        bytes32 x;
        bytes32 y;
        bytes32 rpIdHash;
        bool active;
    }

    struct Agent {
        uint128 perPayment;
        uint128 dailyCap;
        uint64 expiresAt;
        bool active;
        bool frozen;
        uint8 strikes;
        uint64 lastStrikeAt;
    }

    struct Contact {
        address payee;
        uint64 activeAt;
    }

    struct Spend {
        uint64 at;
        uint128 amount;
    }

    /// @notice An agent payment above `holdAbove`, waiting out `holdFor` so the owner can cancel it.
    struct Held {
        address agent;
        address payee;
        bytes32 contactId;
        uint128 amount;
        uint64 releaseAt;
        uint64 heldAt;
    }

    // ------------------------------------------------------------- constants

    uint256 internal constant WINDOW = 24 hours;
    uint256 internal constant AGENT_SLOTS = 16;
    uint256 internal constant VAULT_SLOTS = 48;
    /// @notice Refused attempts within 24 hours before an agent freezes itself.
    uint8 internal constant MAX_STRIKES = 5;
    bytes32 internal constant ACTION_TYPEHASH =
        keccak256("Action(uint8 op,bytes data,uint256 nonce,uint64 deadline,uint256 chainId,address vault)");

    // Refusal codes, shared with the app (see packages/domain).
    uint16 internal constant AGENT_EXPIRED = 2001;
    uint16 internal constant CONTACT_ON_HOLD = 2002;
    uint16 internal constant OVER_AGENT_LIMIT = 2003;
    uint16 internal constant OVER_VAULT_CEILING = 2004;
    uint16 internal constant BREACHES_PROTECTED = 2005;
    uint16 internal constant DUPLICATE_PAYMENT = 2007;
    uint16 internal constant TOO_MANY_PAYMENTS = 2009;
    uint16 internal constant UNKNOWN_CONTACT = 2010;
    uint16 internal constant OVER_CONTACT_LIMIT = 2012;
    uint8 public constant VERSION = 3;

    // ----------------------------------------------------------------- state

    IERC20 public immutable token;
    address public immutable guardian;

    mapping(bytes32 keyId => OwnerKey) public ownerKeys;
    uint256 public ownerKeyCount;

    mapping(address agent => Agent) public agents;
    mapping(address agent => Spend[AGENT_SLOTS]) private _agentSpends;
    mapping(address agent => uint256) private _agentNext;
    Spend[VAULT_SLOTS] private _vaultSpends;
    uint256 private _vaultNext;

    mapping(bytes32 contactId => Contact) public contacts;
    mapping(bytes32 paymentId => bool) public paymentUsed;
    /// @notice Payment ids the owner has paid. Separate from agents' ids, so an agent can't use up
    /// the id of a payment the owner is about to approve.
    mapping(bytes32 paymentId => bool) public ownerPaid;
    mapping(uint256 nonce => bool) public nonceUsed;

    uint256 public protectedAmount;
    uint256 public dailyCeiling;
    uint64 public newContactDelay;
    uint64 public changeDelay;
    uint256 public holdAbove;
    uint64 public holdFor;
    bool public frozen;

    mapping(bytes32 paymentId => Held) public held;
    uint256 public heldTotal;
    /// @notice Owner actions that loosen policy, by id, and when they may apply.
    mapping(bytes32 changeId => uint64 readyAt) public queued;
    /// @notice Any revocation or freeze starts a new generation, so changes approved before it can no
    /// longer apply; the owner approves them again.
    uint64 public generation;
    /// @dev Changes applied so far to each target (the rules, one agent, one contact). A queued change
    /// is stale once its target has changed since it was approved, so it can't undo a later tightening.
    mapping(bytes32 target => uint64) private _epoch;
    /// @dev The generation and target epochs a queued change was approved under.
    mapping(bytes32 changeId => bytes32) private _queuedStamp;
    /// @dev Where a held payment sits in each 24-hour ring (agent, vault, contact), so its release
    /// can move it to the time the money actually leaves.
    mapping(bytes32 paymentId => uint256) private _heldSlots;

    /// @notice Optional rolling 24-hour cap per contact across all agents (0 = none).
    mapping(bytes32 contactId => uint128) public contactCap;
    mapping(bytes32 contactId => Spend[AGENT_SLOTS]) private _contactSpends;
    mapping(bytes32 contactId => uint256) private _contactNext;
    /// @dev One saved contact per address, so an address's waiting period is never borrowed from
    /// another (since removed) contact for it.
    mapping(address payee => bytes32) private _contactOf;
    /// @dev Bumped on each revocation. A hold records both, so a later grant can't revive it.
    mapping(address agent => uint32) private _agentRevocations;
    mapping(bytes32 contactId => uint32) private _contactRevocations;
    /// @dev Bumped when a passkey's removal is requested: what that key queued no longer applies.
    mapping(bytes32 keyId => uint64) private _keyEpoch;
    mapping(bytes32 changeId => bytes32) private _queuedSigner;

    // ---------------------------------------------------------------- events

    event PaymentExecuted(
        bytes32 indexed paymentId,
        address indexed agent,
        bytes32 indexed contactId,
        address payee,
        uint256 amount,
        bytes32 purposeHash
    );
    event PaymentRefused(
        bytes32 indexed paymentId, address indexed agent, bytes32 indexed contactId, uint256 amount, uint16 code
    );
    event OwnerPaid(bytes32 indexed paymentId, address indexed to, uint256 amount, uint256 nonce);
    event OwnerAction(Op indexed op, uint256 nonce, bytes32 keyId);
    event AgentSet(address indexed agent, uint128 perPayment, uint128 dailyCap, uint64 expiresAt);
    event AgentRemoved(address indexed agent);
    event ContactAdded(bytes32 indexed contactId, address payee, uint64 activeAt);
    event ContactRemoved(bytes32 indexed contactId);
    event PolicyChanged(
        uint256 protectedAmount,
        uint256 dailyCeiling,
        uint64 newContactDelay,
        uint64 changeDelay,
        uint256 holdAbove,
        uint64 holdFor
    );
    event PaymentHeld(
        bytes32 indexed paymentId,
        address indexed agent,
        bytes32 indexed contactId,
        address payee,
        uint256 amount,
        uint64 releaseAt,
        bytes32 purposeHash
    );
    event PaymentReleased(bytes32 indexed paymentId, address indexed payee, uint256 amount);
    event PaymentCancelled(bytes32 indexed paymentId, address by);
    event ChangeQueued(bytes32 indexed changeId, Op op, uint256 nonce, uint64 readyAt);
    event ChangeApplied(bytes32 indexed changeId);
    event ChangeCancelled(bytes32 indexed changeId, address by);
    event Struck(address indexed agent, uint8 strikes);
    event NewGeneration(uint64 generation);
    event Frozen(address indexed agent, address by);
    event Unfrozen(address indexed agent);
    event OwnerKeyAdded(bytes32 indexed keyId);
    event OwnerKeyRemoved(bytes32 indexed keyId);

    // ---------------------------------------------------------------- errors

    error NotAgent(); //          1001
    error AgentFrozen(); //       1002
    error NotGuardian();
    error Expired();
    error NonceUsed();
    error UnknownKey();
    error WrongSite();
    error BadSignature();
    error InvalidKey();
    error LastKey();
    error BadAction();
    error InsufficientBalance();
    error BreachesProtected();
    error NotReady();
    error NotQueued();
    error Stale();

    constructor(
        IERC20 token_,
        address guardian_,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        uint256 protectedAmount_,
        uint256 dailyCeiling_,
        uint64 newContactDelay_
    ) {
        if (address(token_) == address(0) || guardian_ == address(0)) revert BadAction();
        token = token_;
        guardian = guardian_;
        _addKey(x, y, rpIdHash);
        protectedAmount = protectedAmount_;
        dailyCeiling = dailyCeiling_;
        newContactDelay = newContactDelay_;
        emit PolicyChanged(protectedAmount_, dailyCeiling_, newContactDelay_, 0, 0, 0);
    }

    // ------------------------------------------------------------ agent path

    /// @notice An agent pays a saved contact. Policy failures do not revert: they return false and
    /// emit PaymentRefused, so every refused attempt that reaches the contract is on-chain evidence.
    function agentPay(bytes32 contactId, uint256 amount, bytes32 paymentId, bytes32 purposeHash)
        external
        returns (bool)
    {
        Agent storage a = agents[msg.sender];
        if (!a.active) revert NotAgent();
        if (a.frozen || frozen) revert AgentFrozen();

        uint16 code = _refusal(a, msg.sender, contactId, amount, paymentId);
        if (code != 0) {
            emit PaymentRefused(paymentId, msg.sender, contactId, amount, code);
            _strike(a, msg.sender);
            return false;
        }

        paymentUsed[paymentId] = true;
        address payee = contacts[contactId].payee;
        bool hold = holdFor > 0 && amount > holdAbove;
        // A held payment counts from now until 24 hours after the money leaves, so outflow in any
        // 24 hours stays within the limits however holds and releases line up.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 at = uint64(block.timestamp) + (hold ? holdFor : 0);
        uint256 slots = _record(msg.sender, contactId, amount, at);
        if (hold) {
            _heldSlots[paymentId] =
                slots | (uint256(_agentRevocations[msg.sender]) << 32) | (uint256(_contactRevocations[contactId]) << 64);
            // forge-lint: disable-next-line(unsafe-typecast)
            held[paymentId] = Held(msg.sender, payee, contactId, uint128(amount), at, uint64(block.timestamp));
            heldTotal += amount;
            emit PaymentHeld(paymentId, msg.sender, contactId, payee, amount, at, purposeHash);
            return true;
        }
        emit PaymentExecuted(paymentId, msg.sender, contactId, payee, amount, purposeHash);
        token.safeTransfer(payee, amount);
        return true;
    }

    /// @notice Anyone may settle a held payment once its window has passed. It is paid only if its agent
    /// is still registered and unexpired and its contact is unchanged since the hold; otherwise it is
    /// cancelled and the money freed. While the vault or agent is frozen, or paying would dip into the
    /// protected amount, it stays held. One not settled within 24 hours of its release time is cancelled.
    function release(bytes32 paymentId) external {
        Held memory h = held[paymentId];
        if (h.amount == 0) revert NotQueued();
        if (block.timestamp < h.releaseAt) revert NotReady();
        Agent memory a = agents[h.agent];
        Contact memory c = contacts[h.contactId];
        uint256 gens = _heldSlots[paymentId];
        bool revoked = uint32(gens >> 32) != _agentRevocations[h.agent] || uint32(gens >> 64) != _contactRevocations[h.contactId];
        if (
            revoked || !a.active || a.expiresAt < block.timestamp || c.payee != h.payee || c.activeAt > h.heldAt
                || block.timestamp >= h.releaseAt + WINDOW
        ) {
            _cancelHeld(paymentId);
            return;
        }
        if (frozen || a.frozen) revert AgentFrozen();
        // Other holds stay reserved; this one may only use what is above the protected amount.
        if (_free() < protectedAmount) revert BreachesProtected();
        if (block.timestamp > h.releaseAt) _moveSpends(paymentId, h);
        delete held[paymentId];
        delete _heldSlots[paymentId];
        heldTotal -= h.amount;
        emit PaymentReleased(paymentId, h.payee, h.amount);
        token.safeTransfer(h.payee, h.amount);
    }

    /// @dev Repeated refusals look like a hijacked agent. Strikes fade after a quiet day.
    function _strike(Agent storage a, address agent) private {
        if (block.timestamp > uint256(a.lastStrikeAt) + WINDOW) a.strikes = 0;
        a.strikes += 1;
        // forge-lint: disable-next-line(unsafe-typecast)
        a.lastStrikeAt = uint64(block.timestamp);
        emit Struck(agent, a.strikes);
        if (a.strikes >= MAX_STRIKES && !a.frozen) {
            a.frozen = true;
            emit Frozen(agent, address(this));
            // Only changes about this agent need approving again; the owner's other changes stand.
            _epoch[_agentKey(agent)] += 1;
        }
    }

    function _refusal(Agent storage a, address agent, bytes32 contactId, uint256 amount, bytes32 paymentId)
        private
        view
        returns (uint16)
    {
        if (a.expiresAt < block.timestamp) return AGENT_EXPIRED;
        Contact memory c = contacts[contactId];
        if (c.payee == address(0)) return UNKNOWN_CONTACT;
        if (c.activeAt > block.timestamp) return CONTACT_ON_HOLD;
        if (paymentUsed[paymentId] || ownerPaid[paymentId]) return DUPLICATE_PAYMENT;
        if (amount == 0 || amount > a.perPayment) return OVER_AGENT_LIMIT;

        (uint256 agentSpent, bool agentFull) = _windowSum(_agentSpends[agent], _agentNext[agent]);
        if (agentFull) return TOO_MANY_PAYMENTS;
        if (agentSpent + amount > a.dailyCap) return OVER_AGENT_LIMIT;

        uint128 cap = contactCap[contactId];
        if (cap > 0) {
            (uint256 toContact, bool contactFull) = _windowSum(_contactSpends[contactId], _contactNext[contactId]);
            if (contactFull) return TOO_MANY_PAYMENTS;
            if (toContact + amount > cap) return OVER_CONTACT_LIMIT;
        }

        (uint256 vaultSpent, bool vaultFull) = _vaultWindowSum();
        if (vaultFull) return TOO_MANY_PAYMENTS;
        if (vaultSpent + amount > dailyCeiling) return OVER_VAULT_CEILING;

        if (amount + protectedAmount > _free()) return BREACHES_PROTECTED;
        return 0;
    }

    /// @dev Balance not already promised to a held payment.
    function _free() private view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        return balance > heldTotal ? balance - heldTotal : 0;
    }

    // ------------------------------------------------------------ owner path

    /// @notice Run an action the owner approved with their passkey. Anyone may submit it (the
    /// relayer pays gas); nobody can change it without invalidating the signature.
    function execute(Action calldata action, bytes32 keyId, WebAuthn.WebAuthnAuth calldata auth) external {
        if (block.timestamp > action.deadline) revert Expired();
        if (nonceUsed[action.nonce]) revert NonceUsed();
        OwnerKey memory k = ownerKeys[keyId];
        if (!k.active) revert UnknownKey();
        // OpenZeppelin leaves the relying-party check to the authenticator; the vault pins it too,
        // so a passkey made for any other site can't sign for this vault.
        if (auth.authenticatorData.length < 37 || bytes32(auth.authenticatorData[0:32]) != k.rpIdHash) {
            revert WrongSite();
        }
        if (!WebAuthn.verify(abi.encodePacked(digest(action)), auth, k.x, k.y, true)) revert BadSignature();

        nonceUsed[action.nonce] = true;
        emit OwnerAction(action.op, action.nonce, keyId);
        // Asking to remove a passkey voids what that key has queued now, not when the removal applies,
        // so a stolen key's queued withdrawal can't mature during the removal's own delay.
        _voidKeysBeingRemoved(action.op, action.data);
        if (changeDelay > 0 && _loosens(action.op, action.data)) {
            bytes32 id = changeIdOf(action.op, action.data, action.nonce);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 readyAt = uint64(block.timestamp) + changeDelay;
            queued[id] = readyAt;
            _queuedSigner[id] = keyId;
            _queuedStamp[id] = _stamp(action.op, action.data, keyId);
            emit ChangeQueued(id, action.op, action.nonce, readyAt);
            return;
        }
        _apply(action.op, action.data, action.nonce);
    }

    /// @notice Apply a queued owner action after its delay. Anyone may call it; while the vault is
    /// frozen only an unfreeze can apply.
    function finalize(Op op, bytes calldata data, uint256 nonce) external {
        bytes32 id = changeIdOf(op, data, nonce);
        uint64 readyAt = queued[id];
        if (readyAt == 0) revert NotQueued();
        bytes32 signer = _queuedSigner[id];
        if (_queuedStamp[id] != _stamp(op, data, signer) || !ownerKeys[signer].active) revert Stale();
        if (block.timestamp < readyAt) revert NotReady();
        if (frozen && op != Op.Unfreeze) revert AgentFrozen();
        delete queued[id];
        delete _queuedStamp[id];
        delete _queuedSigner[id];
        emit ChangeApplied(id);
        _apply(op, data, nonce);
    }

    function changeIdOf(Op op, bytes memory data, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(uint8(op), keccak256(data), nonce));
    }

    function digest(Action calldata action) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                ACTION_TYPEHASH,
                uint8(action.op),
                keccak256(action.data),
                action.nonce,
                action.deadline,
                block.chainid,
                address(this)
            )
        );
    }

    function _apply(Op op, bytes memory data, uint256 nonce) private {
        if (op == Op.Batch) {
            (uint8[] memory ops, bytes[] memory datas) = _batch(data);
            for (uint256 i; i < ops.length; ++i) {
                _applyOne(Op(ops[i]), datas[i], nonce);
            }
        } else {
            _applyOne(op, data, nonce);
        }
    }

    function _batch(bytes memory data) private pure returns (uint8[] memory ops, bytes[] memory datas) {
        (ops, datas) = abi.decode(data, (uint8[], bytes[]));
        if (ops.length != datas.length || ops.length == 0 || ops.length > 32) revert BadAction();
        for (uint256 i; i < ops.length; ++i) {
            if (ops[i] >= uint8(Op.Batch)) revert BadAction();
        }
    }

    /// @notice Whether an owner action gives agents or anyone more power than they have now.
    /// Those wait `changeDelay`; tightening applies at once.
    function _loosens(Op op, bytes memory data) private view returns (bool) {
        if (op == Op.Batch) {
            (uint8[] memory ops, bytes[] memory datas) = _batch(data);
            for (uint256 i; i < ops.length; ++i) {
                if (_loosens(Op(ops[i]), datas[i])) return true;
            }
            return false;
        }
        if (op == Op.SetAgent) {
            (address agent, uint128 perPayment, uint128 dailyCap, uint64 expiresAt) =
                abi.decode(data, (address, uint128, uint128, uint64));
            Agent memory a = agents[agent];
            return !a.active || perPayment > a.perPayment || dailyCap > a.dailyCap || expiresAt > a.expiresAt;
        }
        if (op == Op.AddContact) {
            (bytes32 contactId,, bool immediate, uint128 cap) = abi.decode(data, (bytes32, address, bool, uint128));
            // Otherwise the contact's own waiting period applies; raising or removing its cap loosens.
            uint128 old = contactCap[contactId];
            return immediate || (old != 0 && (cap == 0 || cap > old));
        }
        if (op == Op.Pay) {
            // The owner paying an address that isn't a saved contact waits, so it can be cancelled.
            (address to,,) = abi.decode(data, (address, uint256, bytes32));
            return !_isSavedPayee(to);
        }
        if (op == Op.SetPolicy) {
            (uint256 p, uint256 c, uint64 cd, uint64 d, uint256 ha, uint64 hf) =
                abi.decode(data, (uint256, uint256, uint64, uint64, uint256, uint64));
            return p < protectedAmount || c > dailyCeiling || cd < newContactDelay || d < changeDelay || ha > holdAbove
                || hf < holdFor;
        }
        return op == Op.Unfreeze || op == Op.AddOwnerKey || op == Op.RemoveOwnerKey || op == Op.Withdraw;
    }

    function _applyOne(Op op, bytes memory data, uint256 nonce) private {
        bytes32 target = _target(op, data);
        if (target != 0) _epoch[target] += 1;
        if (op == Op.Pay) {
            (address to, uint256 amount, bytes32 paymentId) = abi.decode(data, (address, uint256, bytes32));
            if (to == address(0) || ownerPaid[paymentId]) revert BadAction();
            // An approved payment still leaves the protected amount; only Withdraw goes below it.
            if (amount + protectedAmount > _free()) revert BreachesProtected();
            ownerPaid[paymentId] = true;
            emit OwnerPaid(paymentId, to, amount, nonce);
            token.safeTransfer(to, amount);
        } else if (op == Op.SetAgent) {
            (address agent, uint128 perPayment, uint128 dailyCap, uint64 expiresAt) =
                abi.decode(data, (address, uint128, uint128, uint64));
            if (agent == address(0) || perPayment > dailyCap) revert BadAction();
            Agent storage a = agents[agent];
            // Changing limits never unfreezes; that takes an explicit Unfreeze.
            (a.perPayment, a.dailyCap, a.expiresAt, a.active) = (perPayment, dailyCap, expiresAt, true);
            emit AgentSet(agent, perPayment, dailyCap, expiresAt);
        } else if (op == Op.RemoveAgent) {
            address agent = abi.decode(data, (address));
            // A frozen tombstone: adding the same key again leaves it frozen until an explicit,
            // delayed Unfreeze, so remove-then-add can't skip the wait.
            agents[agent] = Agent(0, 0, 0, false, true, 0, 0);
            _agentRevocations[agent] += 1;
            emit AgentRemoved(agent);
        } else if (op == Op.AddContact) {
            (bytes32 contactId, address payee, bool immediate, uint128 cap) =
                abi.decode(data, (bytes32, address, bool, uint128));
            if (payee == address(0)) revert BadAction();
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 activeAt = immediate ? uint64(block.timestamp) : uint64(block.timestamp) + newContactDelay;
            // The same address again only changes its cap; it doesn't restart a wait already served.
            Contact memory was = contacts[contactId];
            if (!immediate && was.payee == payee && was.activeAt != 0) activeAt = was.activeAt;
            bytes32 other = _contactOf[payee];
            if (other != 0 && other != contactId) revert BadAction(); // one contact per address
            if (was.payee != address(0) && was.payee != payee) {
                delete _contactOf[was.payee];
                _contactRevocations[contactId] += 1;
            }
            _contactOf[payee] = contactId;
            contacts[contactId] = Contact(payee, activeAt);
            contactCap[contactId] = cap;
            emit ContactAdded(contactId, payee, activeAt);
        } else if (op == Op.RemoveContact) {
            bytes32 contactId = abi.decode(data, (bytes32));
            address payee = contacts[contactId].payee;
            if (payee != address(0)) delete _contactOf[payee];
            delete contacts[contactId];
            delete contactCap[contactId];
            _contactRevocations[contactId] += 1;
            emit ContactRemoved(contactId);
        } else if (op == Op.SetPolicy) {
            (uint256 p, uint256 c, uint64 cd, uint64 d, uint256 ha, uint64 hf) =
                abi.decode(data, (uint256, uint256, uint64, uint64, uint256, uint64));
            (protectedAmount, dailyCeiling, newContactDelay, changeDelay, holdAbove, holdFor) = (p, c, cd, d, ha, hf);
            emit PolicyChanged(p, c, cd, d, ha, hf);
        } else if (op == Op.Unfreeze) {
            address agent = abi.decode(data, (address));
            if (agent == address(0)) {
                frozen = false;
            } else {
                agents[agent].frozen = false;
                agents[agent].strikes = 0;
            }
            emit Unfrozen(agent);
        } else if (op == Op.AddOwnerKey) {
            (bytes32 x, bytes32 y, bytes32 rpIdHash) = abi.decode(data, (bytes32, bytes32, bytes32));
            _addKey(x, y, rpIdHash);
        } else if (op == Op.RemoveOwnerKey) {
            bytes32 keyId = abi.decode(data, (bytes32));
            if (!ownerKeys[keyId].active) revert UnknownKey();
            if (ownerKeyCount == 1) revert LastKey();
            delete ownerKeys[keyId];
            ownerKeyCount--;
            emit OwnerKeyRemoved(keyId);
            // Changes that key approved and that haven't applied yet don't survive it.
            _keyEpoch[keyId] += 1;
        } else if (op == Op.Withdraw) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            if (to == address(0)) revert BadAction();
            if (amount > _free()) revert InsufficientBalance();
            token.safeTransfer(to, amount);
        } else if (op == Op.CancelChange) {
            _cancelChange(abi.decode(data, (bytes32)));
        } else if (op == Op.CancelHeld) {
            _cancelHeld(abi.decode(data, (bytes32)));
        }
    }

    // ------------------------------------------------------------ tightening

    /// @notice Freeze the whole vault. The guardian may do this without the owner; only the owner unfreezes.
    function freeze() external {
        if (msg.sender != guardian) revert NotGuardian();
        frozen = true;
        emit Frozen(address(0), msg.sender);
        _newGeneration();
    }

    /// @notice The guardian freezes any agent; an agent may freeze only itself, and only if registered.
    /// A guardian freeze is an incident: every queued change must be approved again. An agent's own
    /// freeze voids only queued changes about that agent, so nobody else can stall the owner.
    function freezeAgent(address agent) external {
        if (msg.sender != guardian) {
            if (msg.sender != agent) revert NotGuardian();
            if (!agents[agent].active) revert NotAgent();
        }
        agents[agent].frozen = true;
        emit Frozen(agent, msg.sender);
        if (msg.sender == guardian) _newGeneration();
        else _epoch[_agentKey(agent)] += 1;
    }

    /// @notice Stop a held agent payment before it leaves. The budget it used stays used.
    function cancelHeld(bytes32 paymentId) external {
        if (msg.sender != guardian) revert NotGuardian();
        _cancelHeld(paymentId);
    }

    /// @notice Stop a queued loosening before it applies.
    function cancelChange(bytes32 changeId) external {
        if (msg.sender != guardian) revert NotGuardian();
        _cancelChange(changeId);
    }

    function _cancelHeld(bytes32 paymentId) private {
        Held memory h = held[paymentId];
        if (h.amount == 0) revert NotQueued();
        delete held[paymentId];
        delete _heldSlots[paymentId];
        heldTotal -= h.amount;
        emit PaymentCancelled(paymentId, msg.sender);
    }

    function _cancelChange(bytes32 changeId) private {
        if (queued[changeId] == 0) revert NotQueued();
        delete queued[changeId];
        delete _queuedStamp[changeId];
        delete _queuedSigner[changeId];
        emit ChangeCancelled(changeId, msg.sender);
    }

    // ------------------------------------------------------------------ views

    function keyIdOf(bytes32 x, bytes32 y) public pure returns (bytes32) {
        return keccak256(abi.encode(x, y));
    }

    function spentToday(address agent) external view returns (uint256 spent) {
        (spent,) = _windowSum(_agentSpends[agent], _agentNext[agent]);
    }

    function vaultSpentToday() public view returns (uint256 spent) {
        (spent,) = _vaultWindowSum();
    }

    /// @notice The most all agents together can still move right now.
    function agentHeadroom() external view returns (uint256) {
        if (frozen) return 0;
        uint256 spent = vaultSpentToday();
        uint256 byCeiling = dailyCeiling > spent ? dailyCeiling - spent : 0;
        uint256 free = _free();
        uint256 byBalance = free > protectedAmount ? free - protectedAmount : 0;
        return byCeiling < byBalance ? byCeiling : byBalance;
    }

    // -------------------------------------------------------------- internals

    /// @dev A revocation or freeze: loosening approved before it must be approved again.
    function _newGeneration() private {
        generation += 1;
        emit NewGeneration(generation);
    }

    function _isSavedPayee(address payee) private view returns (bool) {
        bytes32 id = _contactOf[payee];
        return id != 0 && contacts[id].activeAt <= block.timestamp;
    }

    function _addKey(bytes32 x, bytes32 y, bytes32 rpIdHash) private {
        if (!P256.isValidPublicKey(x, y)) revert InvalidKey();
        bytes32 keyId = keyIdOf(x, y);
        if (!ownerKeys[keyId].active) ownerKeyCount++;
        ownerKeys[keyId] = OwnerKey(x, y, rpIdHash, true);
        emit OwnerKeyAdded(keyId);
    }

    /// @dev Rolling 24-hour window over a ring of recent payments. If the oldest slot is still inside
    /// the window, the ring is full and further payments are refused until it ages out.
    function _windowSum(Spend[AGENT_SLOTS] storage ring, uint256 next) private view returns (uint256 sum, bool full) {
        uint256 cutoff = block.timestamp > WINDOW ? block.timestamp - WINDOW : 0;
        for (uint256 i; i < AGENT_SLOTS; ++i) {
            Spend memory s = ring[i];
            if (s.at > cutoff) sum += s.amount;
        }
        full = ring[next % AGENT_SLOTS].at > cutoff;
    }

    function _vaultWindowSum() private view returns (uint256 sum, bool full) {
        uint256 cutoff = block.timestamp > WINDOW ? block.timestamp - WINDOW : 0;
        for (uint256 i; i < VAULT_SLOTS; ++i) {
            Spend memory s = _vaultSpends[i];
            if (s.at > cutoff) sum += s.amount;
        }
        full = _vaultSpends[_vaultNext % VAULT_SLOTS].at > cutoff;
    }

    /// @dev Count a payment in the agent's, the vault's and the contact's 24-hour rings. The contact's
    /// is kept even without a cap, so a cap set later counts the last 24 hours too. Returns the three
    /// ring positions, packed, for a held payment's later release.
    function _record(address agent, bytes32 contactId, uint256 amount, uint64 at) private returns (uint256 slots) {
        // Casts are safe: amount <= perPayment (uint128).
        // forge-lint: disable-next-line(unsafe-typecast)
        Spend memory spend = Spend(at, uint128(amount));
        uint256 n = _agentNext[agent];
        _agentSpends[agent][n % AGENT_SLOTS] = spend;
        _agentNext[agent] = n + 1;
        uint256 v = _vaultNext;
        _vaultSpends[v % VAULT_SLOTS] = spend;
        _vaultNext = v + 1;
        uint256 c = _contactNext[contactId];
        _contactSpends[contactId][c % AGENT_SLOTS] = spend;
        _contactNext[contactId] = c + 1;
        slots = (n % AGENT_SLOTS) | ((v % VAULT_SLOTS) << 8) | ((c % AGENT_SLOTS) << 16);
    }

    /// @dev A held payment released late counts from when the money leaves. Its ring entries are
    /// still in place: they are dated `releaseAt`, and a ring only reuses entries older than 24 hours.
    function _moveSpends(bytes32 paymentId, Held memory h) private {
        uint256 slots = _heldSlots[paymentId];
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 nowAt = uint64(block.timestamp);
        _agentSpends[h.agent][slots & 0xff].at = nowAt;
        _vaultSpends[(slots >> 8) & 0xff].at = nowAt;
        _contactSpends[h.contactId][(slots >> 16) & 0xff].at = nowAt;
    }

    /// @dev What a queued change depends on: the generation, and how often each thing it changes has
    /// changed since. Epochs only grow, so their sum is unchanged exactly when none of them moved.
    function _stamp(Op op, bytes memory data, bytes32 signer) private view returns (bytes32) {
        uint256 sum;
        if (op == Op.Batch) {
            (uint8[] memory ops, bytes[] memory datas) = _batch(data);
            for (uint256 i; i < ops.length; ++i) {
                sum += _epoch[_target(Op(ops[i]), datas[i])];
            }
        } else {
            sum = _epoch[_target(op, data)];
        }
        return keccak256(abi.encode(generation, sum, signer, _keyEpoch[signer]));
    }

    /// @dev The thing an action changes: the rules, an agent (by address) or a contact (by id).
    function _target(Op op, bytes memory data) private pure returns (bytes32) {
        if (op == Op.SetPolicy) return keccak256("policy");
        if (op == Op.SetAgent || op == Op.AddContact || op == Op.RemoveAgent || op == Op.RemoveContact) {
            return abi.decode(data, (bytes32));
        }
        // Unfreezing one agent is about that agent; unfreezing the vault is covered by the generation.
        if (op == Op.Unfreeze) return abi.decode(data, (bytes32));
        return 0;
    }

    function _agentKey(address agent) private pure returns (bytes32) {
        return bytes32(uint256(uint160(agent)));
    }

    function _voidKeysBeingRemoved(Op op, bytes memory data) private {
        if (op == Op.Batch) {
            (uint8[] memory ops, bytes[] memory datas) = _batch(data);
            for (uint256 i; i < ops.length; ++i) {
                if (Op(ops[i]) == Op.RemoveOwnerKey) _keyEpoch[abi.decode(datas[i], (bytes32))] += 1;
            }
        } else if (op == Op.RemoveOwnerKey) {
            _keyEpoch[abi.decode(data, (bytes32))] += 1;
        }
    }
}
