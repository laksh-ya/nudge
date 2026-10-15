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
        AddContact, //     (bytes32 contactId, address payee, bool immediate)
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
    }

    // ------------------------------------------------------------- constants

    uint256 public constant WINDOW = 24 hours;
    uint256 public constant AGENT_SLOTS = 16;
    uint256 public constant VAULT_SLOTS = 48;
    /// @notice Refused attempts within 24 hours before an agent freezes itself.
    uint8 public constant MAX_STRIKES = 5;
    bytes32 public constant ACTION_TYPEHASH =
        keccak256("Action(uint8 op,bytes data,uint256 nonce,uint64 deadline,uint256 chainId,address vault)");

    // Refusal codes, shared with the app (see packages/domain).
    uint16 public constant AGENT_EXPIRED = 2001;
    uint16 public constant CONTACT_ON_HOLD = 2002;
    uint16 public constant OVER_AGENT_LIMIT = 2003;
    uint16 public constant OVER_VAULT_CEILING = 2004;
    uint16 public constant BREACHES_PROTECTED = 2005;
    uint16 public constant DUPLICATE_PAYMENT = 2007;
    uint16 public constant TOO_MANY_PAYMENTS = 2009;
    uint16 public constant UNKNOWN_CONTACT = 2010;

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
        _record(msg.sender, amount);
        address payee = contacts[contactId].payee;
        if (holdFor > 0 && amount > holdAbove) {
            // Counted against every limit now; the money leaves only after the owner had time to cancel.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 releaseAt = uint64(block.timestamp) + holdFor;
            // forge-lint: disable-next-line(unsafe-typecast)
            held[paymentId] = Held(msg.sender, payee, contactId, uint128(amount), releaseAt);
            heldTotal += amount;
            emit PaymentHeld(paymentId, msg.sender, contactId, payee, amount, releaseAt, purposeHash);
            return true;
        }
        emit PaymentExecuted(paymentId, msg.sender, contactId, payee, amount, purposeHash);
        token.safeTransfer(payee, amount);
        return true;
    }

    /// @notice Anyone may release a held payment once its window has passed, unless it was cancelled,
    /// the vault or agent has since been frozen, or the contact was removed or changed.
    function release(bytes32 paymentId) external {
        Held memory h = held[paymentId];
        if (h.amount == 0) revert NotQueued();
        if (block.timestamp < h.releaseAt) revert NotReady();
        if (frozen || agents[h.agent].frozen) revert AgentFrozen();
        if (contacts[h.contactId].payee != h.payee) revert BadAction();
        delete held[paymentId];
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
        if (paymentUsed[paymentId]) return DUPLICATE_PAYMENT;
        if (amount == 0 || amount > a.perPayment) return OVER_AGENT_LIMIT;

        (uint256 agentSpent, bool agentFull) = _windowSum(_agentSpends[agent], _agentNext[agent]);
        if (agentFull) return TOO_MANY_PAYMENTS;
        if (agentSpent + amount > a.dailyCap) return OVER_AGENT_LIMIT;

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
        if (changeDelay > 0 && _loosens(action.op, action.data)) {
            bytes32 id = changeIdOf(action.op, action.data, action.nonce);
            // forge-lint: disable-next-line(unsafe-typecast)
            uint64 readyAt = uint64(block.timestamp) + changeDelay;
            queued[id] = readyAt;
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
        if (block.timestamp < readyAt) revert NotReady();
        if (frozen && op != Op.Unfreeze) revert AgentFrozen();
        delete queued[id];
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
            (,, bool immediate) = abi.decode(data, (bytes32, address, bool));
            return immediate; // otherwise the contact's own waiting period applies
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
        if (op == Op.Pay) {
            (address to, uint256 amount, bytes32 paymentId) = abi.decode(data, (address, uint256, bytes32));
            if (to == address(0) || paymentUsed[paymentId]) revert BadAction();
            // An approved payment still leaves the protected amount; only Withdraw goes below it.
            if (amount + protectedAmount > _free()) revert BreachesProtected();
            paymentUsed[paymentId] = true;
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
            delete agents[agent];
            emit AgentRemoved(agent);
        } else if (op == Op.AddContact) {
            (bytes32 contactId, address payee, bool immediate) = abi.decode(data, (bytes32, address, bool));
            if (payee == address(0)) revert BadAction();
            uint64 activeAt = immediate ? uint64(block.timestamp) : uint64(block.timestamp) + newContactDelay;
            contacts[contactId] = Contact(payee, activeAt);
            emit ContactAdded(contactId, payee, activeAt);
        } else if (op == Op.RemoveContact) {
            bytes32 contactId = abi.decode(data, (bytes32));
            delete contacts[contactId];
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
    }

    function freezeAgent(address agent) external {
        if (msg.sender != guardian && msg.sender != agent) revert NotGuardian();
        agents[agent].frozen = true;
        emit Frozen(agent, msg.sender);
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
        heldTotal -= h.amount;
        emit PaymentCancelled(paymentId, msg.sender);
    }

    function _cancelChange(bytes32 changeId) private {
        if (queued[changeId] == 0) revert NotQueued();
        delete queued[changeId];
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

    function _record(address agent, uint256 amount) private {
        uint256 n = _agentNext[agent];
        // Casts are safe: amount <= perPayment (uint128) and timestamps fit in uint64.
        // forge-lint: disable-next-line(unsafe-typecast)
        _agentSpends[agent][n % AGENT_SLOTS] = Spend(uint64(block.timestamp), uint128(amount));
        _agentNext[agent] = n + 1;
        uint256 v = _vaultNext;
        // forge-lint: disable-next-line(unsafe-typecast)
        _vaultSpends[v % VAULT_SLOTS] = Spend(uint64(block.timestamp), uint128(amount));
        _vaultNext = v + 1;
    }
}
