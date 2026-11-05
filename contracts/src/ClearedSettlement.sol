// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IUSDT3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

contract ClearedSettlement {
    IUSDT3009 public immutable USDT; // 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7
    address public immutable TREASURY; // receives fees; fees buy WBT for the relayer
    uint256 public constant FEE_BPS = 50; // 0.5%
    uint256 public constant FEE_CAP = 2_000_000; // 2 USDT (6 decimals)
    uint256 public constant MIN_VALUE = 5_000_000; // 5 USDT, so every fee covers its own gas

    struct Settlement {
        address payer;
        address payee;
        uint128 value;
        uint64 paidAt;
    }

    mapping(bytes32 invoiceId => Settlement) public settlements;

    event InvoiceSettled(
        bytes32 indexed invoiceId, address indexed payee, address indexed payer, uint256 value, uint256 fee
    );

    error AlreadySettled(bytes32 invoiceId);
    error BelowMinimum();
    error TransferFailed();

    constructor(IUSDT3009 usdt, address treasury) {
        USDT = usdt;
        TREASURY = treasury;
    }

    /// The EIP-3009 nonce the payer signs. Binds version, chain, this contract, invoice, payee, amount.
    function nonceFor(bytes32 invoiceId, address payee, uint256 value) public view returns (bytes32) {
        return
            keccak256(abi.encode(bytes32("CLEARED_SETTLE_V1"), block.chainid, address(this), invoiceId, payee, value));
    }

    /// Permissionless: anyone may pay the gas. Only the payer's signed USDT moves, only to the signed payee.
    function settle(
        bytes32 invoiceId,
        address payer,
        address payee,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (settlements[invoiceId].paidAt != 0) revert AlreadySettled(invoiceId);
        if (value < MIN_VALUE) revert BelowMinimum();
        settlements[invoiceId] = Settlement(payer, payee, uint128(value), uint64(block.timestamp));
        USDT.receiveWithAuthorization(
            payer, address(this), value, validAfter, validBefore, nonceFor(invoiceId, payee, value), v, r, s
        );
        uint256 fee = value * FEE_BPS / 10_000;
        if (fee > FEE_CAP) fee = FEE_CAP;
        _safeTransfer(payee, value - fee);
        if (fee != 0) _safeTransfer(TREASURY, fee);
        emit InvoiceSettled(invoiceId, payee, payer, value, fee);
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            address(USDT).call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
