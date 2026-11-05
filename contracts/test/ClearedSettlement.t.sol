// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {ClearedSettlement, IUSDT3009} from "../src/ClearedSettlement.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// Runs on a fork of chain 1874 against the real USDT proxy.
contract ClearedSettlementTest is Test {
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant INVOICE = keccak256("invoice-1");
    uint256 constant VALUE = 600_000_000; // 600 USDT

    ClearedSettlement settlement;
    uint256 payerKey = 0xC11E27;
    address payer;
    address payee = makeAddr("payee");
    address treasury = makeAddr("treasury");
    address relayer = makeAddr("relayer");

    event InvoiceSettled(
        bytes32 indexed invoiceId, address indexed payee, address indexed payer, uint256 value, uint256 fee
    );

    function setUp() public {
        vm.createSelectFork("whitechain");
        payer = vm.addr(payerKey);
        settlement = new ClearedSettlement(IUSDT3009(USDT), treasury);
        deal(USDT, payer, 1_000_000_000);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Tether USD"),
                keccak256("1"),
                block.chainid,
                USDT
            )
        );
    }

    function _sign(uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, payer, address(settlement), value, 0, validBefore, nonce));
        return vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash)));
    }

    function _settle(bytes32 invoiceId, address to, uint256 value, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)
        internal
    {
        vm.prank(relayer);
        settlement.settle(invoiceId, payer, to, value, 0, validBefore, v, r, s);
    }

    function test_signedAuthorizationSettles() public {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(VALUE, validBefore, settlement.nonceFor(INVOICE, payee, VALUE));
        uint256 fee = 2_000_000; // 0.5% of 600 is 3 USDT, so the 2 USDT cap applies

        vm.expectEmit(address(settlement));
        emit InvoiceSettled(INVOICE, payee, payer, VALUE, fee);
        _settle(INVOICE, payee, VALUE, validBefore, v, r, s);

        assertEq(IERC20(USDT).balanceOf(payee), VALUE - fee);
        assertEq(IERC20(USDT).balanceOf(treasury), fee);
        assertEq(IERC20(USDT).balanceOf(address(settlement)), 0);
        assertEq(IERC20(USDT).balanceOf(payer), 1_000_000_000 - VALUE);

        (address storedPayer, address storedPayee, uint128 storedValue, uint64 paidAt) = settlement.settlements(INVOICE);
        assertEq(storedPayer, payer);
        assertEq(storedPayee, payee);
        assertEq(storedValue, VALUE);
        assertEq(paidAt, block.timestamp);
    }

    function test_feeBelowCapIsHalfAPercent() public {
        uint256 value = 100_000_000;
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(value, validBefore, settlement.nonceFor(INVOICE, payee, value));

        _settle(INVOICE, payee, value, validBefore, v, r, s);

        assertEq(IERC20(USDT).balanceOf(treasury), 500_000);
        assertEq(IERC20(USDT).balanceOf(payee), 99_500_000);
    }

    function test_secondSettleForSameInvoiceReverts() public {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(VALUE, validBefore, settlement.nonceFor(INVOICE, payee, VALUE));
        _settle(INVOICE, payee, VALUE, validBefore, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(ClearedSettlement.AlreadySettled.selector, INVOICE));
        _settle(INVOICE, payee, VALUE, validBefore, v, r, s);
    }

    function test_changedPayeeReverts() public {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(VALUE, validBefore, settlement.nonceFor(INVOICE, payee, VALUE));

        vm.expectRevert();
        _settle(INVOICE, makeAddr("attacker"), VALUE, validBefore, v, r, s);
        _assertUnsettled();
    }

    function test_changedValueReverts() public {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(VALUE, validBefore, settlement.nonceFor(INVOICE, payee, VALUE));

        vm.expectRevert();
        _settle(INVOICE, payee, VALUE - 1, validBefore, v, r, s);
        _assertUnsettled();
    }

    function test_directCallToTokenFromEoaReverts() public {
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = settlement.nonceFor(INVOICE, payee, VALUE);
        (uint8 v, bytes32 r, bytes32 s) = _sign(VALUE, validBefore, nonce);

        vm.prank(makeAddr("mempool-watcher"));
        vm.expectRevert();
        IUSDT3009(USDT).receiveWithAuthorization(payer, address(settlement), VALUE, 0, validBefore, nonce, v, r, s);
        assertFalse(IUSDT3009(USDT).authorizationState(payer, nonce));
    }

    function test_expiredAuthorizationRevertsAndRollsBack() public {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(VALUE, validBefore, settlement.nonceFor(INVOICE, payee, VALUE));
        vm.warp(validBefore + 1);

        vm.expectRevert();
        _settle(INVOICE, payee, VALUE, validBefore, v, r, s);
        _assertUnsettled();
    }

    function test_valueBelowMinimumReverts() public {
        uint256 value = 4_999_999;
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(value, validBefore, settlement.nonceFor(INVOICE, payee, value));

        vm.expectRevert(ClearedSettlement.BelowMinimum.selector);
        _settle(INVOICE, payee, value, validBefore, v, r, s);
    }

    function _assertUnsettled() internal view {
        (,,, uint64 paidAt) = settlement.settlements(INVOICE);
        assertEq(paidAt, 0);
    }
}
