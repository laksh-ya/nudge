// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {PolicyVaultTest} from "./PolicyVault.t.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
/// Desired properties: these fail at PR43 a9d9ed7. Uses real P256 owner assertions.
contract V3AdversarialReview is PolicyVaultTest {
 function test_review_strangerCannotInvalidateOwnerQueue() public {
  policy(50e6,40e6,1 days,120,0,0);
  bytes memory data=abi.encode(makeAddr("withdraw-recipient"),1e6);
  sign(PolicyVault.Op.Withdraw,data);uint256 n=nonce;
  address stranger=makeAddr("stranger");vm.prank(stranger);vault.freezeAgent(stranger);
  vm.warp(block.timestamp+121);
  vault.finalize(PolicyVault.Op.Withdraw,data,n);
  assertEq(token.balanceOf(makeAddr("withdraw-recipient")),1e6);
 }
 function test_review_removedMatureAliasDoesNotTrustImmatureAlias() public {
  bytes32 aliasId=keccak256("alias");
  sign(PolicyVault.Op.AddContact,abi.encode(aliasId,shop,false,uint128(0)));
  sign(PolicyVault.Op.RemoveContact,abi.encode(shopId));
  policy(50e6,40e6,1 days,120,0,0);
  sign(PolicyVault.Op.Pay,abi.encode(shop,3e6,bytes32("alias-pay")));
  assertEq(token.balanceOf(shop),0,"remaining contact is still cooling, owner payment must queue");
 }
 function test_review_capEnabledAfter17PaymentsCountsAllSpending() public {
  for(uint256 i=1;i<=17;i++)assertTrue(pay(i<=9?claude:chatgpt,1e6,bytes32(i)));
  sign(PolicyVault.Op.AddContact,abi.encode(shopId,shop,false,uint128(17e6)));
  assertFalse(pay(chatgpt,1e6,bytes32("eighteenth")),"17 spent already, new cap is 17");
  assertEq(token.balanceOf(shop),17e6);
 }
 function test_review_agentRegrantDoesNotResurrectOldHold() public {
  policy(50e6,40e6,1 days,0,5e6,120);assertTrue(pay(claude,8e6,bytes32("old-hold")));
  sign(PolicyVault.Op.RemoveAgent,abi.encode(claude));
  sign(PolicyVault.Op.SetAgent,abi.encode(claude,uint128(10e6),uint128(15e6),uint64(block.timestamp+30 days)));
  sign(PolicyVault.Op.Unfreeze,abi.encode(claude));
  vm.warp(block.timestamp+121);vault.release(bytes32("old-hold"));
  assertEq(token.balanceOf(shop),0,"new grant must not revive a previously revoked hold");
 }
 function test_review_sameBlockContactRegrantDoesNotResurrectOldHold() public {
  policy(50e6,40e6,0,0,5e6,120);assertTrue(pay(claude,8e6,bytes32("contact-hold")));
  sign(PolicyVault.Op.RemoveContact,abi.encode(shopId));
  sign(PolicyVault.Op.AddContact,abi.encode(shopId,shop,true,uint128(0)));
  vm.warp(block.timestamp+121);vault.release(bytes32("contact-hold"));
  assertEq(token.balanceOf(shop),0,"equal block timestamps must not replace a contact generation check");
 }
 function test_review_keyRevocationProtectsBeforeAttackerQueueMatures() public {
  uint256 backupPk=0xB0B;(uint256 x,uint256 y)=vm.publicKeyP256(backupPk);
  sign(PolicyVault.Op.AddOwnerKey,abi.encode(bytes32(x),bytes32(y),sha256(bytes(RP_ID))));
  policy(50e6,40e6,1 days,120,0,0);
  address thief=makeAddr("thief");bytes memory data=abi.encode(thief,250e6);
  sign(PolicyVault.Op.Withdraw,data);uint256 stealNonce=nonce;
  vm.warp(block.timestamp+30);
  PolicyVault.Action memory removal=action(PolicyVault.Op.RemoveOwnerKey,abi.encode(keyId));
  bytes32 backupId=vault.keyIdOf(bytes32(x),bytes32(y));
  vault.execute(removal,backupId,assertion(backupPk,vault.digest(removal),RP_ID,0x05));
  vm.warp(block.timestamp+91);
  try vault.finalize(PolicyVault.Op.Withdraw,data,stealNonce) {} catch {}
  assertEq(token.balanceOf(thief),0,"revocation signed during the defence window must stop the older withdrawal");
 }
 function test_review_ownerPaidIdCannotBePaidAgainByAgent() public {
  sign(PolicyVault.Op.Pay,abi.encode(shop,3e6,bytes32("invoice")));
  assertFalse(pay(claude,3e6,bytes32("invoice")),"agent cannot pay an already owner-paid invoice");
  assertEq(token.balanceOf(shop),3e6);
 }
}
