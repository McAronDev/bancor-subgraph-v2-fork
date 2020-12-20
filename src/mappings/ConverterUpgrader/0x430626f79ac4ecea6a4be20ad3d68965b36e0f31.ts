import { 
    Converter as ConverterEntity,
    ConverterBalance as ConverterBalanceEntity,
    PoolToken as PoolTokenEntity,
    Token as TokenEntity,
} from '../../../generated/schema'
import {
    LiquidityPoolV2Converter
} from '../../../generated/ConverterUpgrader-0x430626f79ac4ecea6a4be20ad3d68965b36e0f31/LiquidityPoolV2Converter'
import {
    ERC20Token
} from '../../../generated/ConverterUpgrader-0x430626f79ac4ecea6a4be20ad3d68965b36e0f31/ERC20Token'
import {
    ConverterUpgrader,
    ConverterOwned as ConverterOwnedEvent,
    ConverterUpgrade as ConverterUpgradeEvent,
    OwnerUpdate as OwnerUpdateEvent
} from '../../../generated/ConverterUpgrader-0x430626f79ac4ecea6a4be20ad3d68965b36e0f31/ConverterUpgrader'
import { log, BigDecimal, BigInt, Address, Bytes } from '@graphprotocol/graph-ts'
import {ethereum, ValueKind} from '@graphprotocol/graph-ts/index';

export function handleConverterOwned(event: ConverterOwnedEvent): void {}

/**
 * In the event of an upgrade, the old converter moves to the new one.
 */
export function handleConverterUpgrade(event: ConverterUpgradeEvent): void {
    let newConverterAddress = event.params._newConverter;
    let oldConverterAddress = event.params._oldConverter;
    
    let newConverter = ConverterEntity.load(newConverterAddress.toHexString());
    let oldConverter = ConverterEntity.load(oldConverterAddress.toHexString());
    if (newConverter === null || oldConverter === null) {
        log.warning("handleConverterUpgrade: Conversion not handled from {} {} to {} {}", [
            oldConverterAddress.toHexString(),
            oldConverter === null ? "(Not found)" : "",
            newConverterAddress.toHexString(),
            newConverter === null ? "(Not found)" : ""
        ])
        return
    }

    newConverter.upgradedFrom = oldConverter.id;
    newConverter.save()

    oldConverter.upgradedTo = newConverter.id;
    oldConverter.save()

    if (oldConverter.type.gt(BigInt.fromI32(0))) {
        _updateReserveBalancesAndWeights(oldConverterAddress);
    }
    else {
        log.warning("Did not updated balances for {}", [oldConverter.id])
    }
}

export function handleOwnerUpdate(event: OwnerUpdateEvent): void {}

function _createAndReturnConverterBalance(converterAddress: Address, tokenAddress: Address): ConverterBalanceEntity {
    let id = converterAddress.toHexString() + "-" + tokenAddress.toHexString();
    let converterBalance = ConverterBalanceEntity.load(id);
    let poolTokenAddress: Address | null;
    if (converterBalance === null) {
        // Get poolToken
        let converter = ConverterEntity.load(id);
        let converterType = converter.get('type');
        converterType.kind = ValueKind.STRING;


        if (converterType.toString() == String.fromCharCode(2)) {
            let converterContract = LiquidityPoolV2Converter.bind(converterAddress);
            let poolTokenResult = converterContract.try_poolToken(tokenAddress);
            if (poolTokenResult.reverted) {
                log.error("_createAndReturnConverterBalance contract call reverted {}", [id])
            }
            poolTokenAddress = poolTokenResult.value;
        }

        // Create converter balance
        converterBalance = new ConverterBalanceEntity(id);
        converterBalance.converter = converterAddress.toHexString();
        converterBalance.poolToken = poolTokenAddress ? poolTokenAddress.toHexString() : null;
        converterBalance.token = tokenAddress.toHexString();
        converterBalance.stakedAmount = BigDecimal.fromString("0.0");
        converterBalance.balance = BigDecimal.fromString("0.0");
        converterBalance.weight = BigDecimal.fromString("0.0");
        converterBalance.save();
    }
    return converterBalance!
}

function _updateReserveBalancesAndWeights(converterAddress: Address): void {
    let id = converterAddress.toHexString();
    let converter = ConverterEntity.load(id);
    if (converter === null) {
        log.warning("_updateReserveBalancesAndWeights Converter not found {}", [id])
        return
    }

    let converterContract = LiquidityPoolV2Converter.bind(converterAddress);

    // Update price oracle
    let priceOracleResult = converterContract.try_priceOracle();
    converter.priceOracle = priceOracleResult.reverted ? null : priceOracleResult.value.toHexString();
    converter.save()


    // Update balances and weights
    let i = BigInt.fromI32(0);
    let isReverted = false;
    while (!isReverted) {
        let reserveTokenResult = converterContract.try_reserveTokens(i);
        if (reserveTokenResult.reverted) {
            isReverted = true;
            continue
        }

        let reserveBalanceResult = converterContract.try_reserveBalance(reserveTokenResult.value);


        if (reserveBalanceResult.reverted){

            log.warning("try_reserveBalance reverted for converter {} and token {}. Converter v{}", [
                id,
                reserveTokenResult.value.toHexString(),
                converter.version.toString()
            ]);
            reserveBalanceResult = ethereum.CallResult.fromValue(BigInt.fromI32(0));

        }


        let reserveWeightResult = converterContract.try_reserveWeight(reserveTokenResult.value);

        if (reserveWeightResult.reverted){
            log.error("try_reserveWeight reverted for converter {} and token {}", [
                id,
                reserveTokenResult.value.toHexString()
            ]);
        }


        let reserveToken = TokenEntity.load(reserveTokenResult.value.toHexString());
        if (reserveToken === null) {
            log.error("_updateReserveBalancesAndWeights token not found for converter {} and token {}", [
                id,
                reserveTokenResult.value.toHexString()
            ]);
            isReverted = true;
            continue
        }

        let converterBalance = _createAndReturnConverterBalance(converterAddress, reserveTokenResult.value);

        // Update converter actual balance
        if (reserveTokenResult.value.toHexString() != '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
            let reserveTokenContract = ERC20Token.bind(reserveTokenResult.value);

            let balanceOf = reserveTokenContract.try_balanceOf(converterAddress);
            if (!balanceOf.reverted) {
                converterBalance.balance = balanceOf.value.divDecimal((BigInt.fromI32(10).pow(reserveToken.decimals.toI32() as u8).toBigDecimal()));
            } else {
                log.warning("Balance of reverted for {} {}", [
                    converterAddress.toHexString(),
                    reserveTokenResult.value.toHexString()
                ])
            }
        }

        let isActive = converterContract.try_isActive();
        if (!isActive.reverted) {
            if (isActive.value) {
                converterBalance.stakedAmount = reserveBalanceResult.value.divDecimal((BigInt.fromI32(10).pow(reserveToken.decimals.toI32() as u8).toBigDecimal()));
            }
            else {
                converterBalance.stakedAmount = BigDecimal.fromString('0');
            }
        }
        else {
            log.warning("isActive reverted for {} {}", [
                converterAddress.toHexString(),
                reserveTokenResult.value.toHexString()
            ])
        }

        // Update converter balance
        converterBalance.weight = reserveWeightResult.value.divDecimal(BigDecimal.fromString("1000000")); // Weight is given in ppm
        converterBalance.save();

        // Calculate shareValue
        let poolTokenAddress = Address.fromHexString(converterBalance.poolToken) as Address;
        let poolToken = PoolTokenEntity.load(poolTokenAddress.toHexString())
        let shareValue = BigDecimal.fromString("0.0");

        if (poolToken !== null) {
            let poolTokenSupply = poolToken.supply;
            if (poolTokenSupply.gt(BigDecimal.fromString("0.0"))) {
                shareValue = converterBalance.stakedAmount.div(poolTokenSupply);
            }
            poolToken.shareValue = shareValue;
            // todo pooltoken.shareValueEth
            poolToken.save();
        }

        i = i.plus(BigInt.fromI32(1));
    }
}