// Testing if I can create converters from the ConverterUpgrader
// The idea is that Converters via Factories will already be created
// IF THIS PICKS UP MORE CONVERTERS, DO FOR THE REST
import {
    Converter as ConverterEntity,
    ConverterBalance as ConverterBalanceEntity,
    PoolToken as PoolTokenEntity,
    Token as TokenEntity,
} from '../../../generated/schema'
import {
    LiquidityPoolV2Converter
} from '../../../generated/ConverterUpgrader-0xc724bc5f3dd616c8fadb75a23c00c13880a6268f/LiquidityPoolV2Converter'
import {
    LiquidityPoolV1Converter
} from '../../../generated/ConverterUpgrader-0xc724bc5f3dd616c8fadb75a23c00c13880a6268f/LiquidityPoolV1Converter'
import {
    Converter27 as Converter27Contract
} from '../../../generated/ConverterUpgrader-0xc724bc5f3dd616c8fadb75a23c00c13880a6268f/Converter27'
import {
    Converter25 as Converter25Contract
} from '../../../generated/ConverterUpgrader-0xc724bc5f3dd616c8fadb75a23c00c13880a6268f/Converter25'
import {
    ERC20Token
} from '../../../generated/ConverterUpgrader-0xc724bc5f3dd616c8fadb75a23c00c13880a6268f/ERC20Token'
import {
    LiquidityPoolV2Converter as LiquidityPoolV2ConverterTemplate,
    LiquidityPoolV1Converter as LiquidityPoolV1ConverterTemplate,
    Converter27 as Converter27Template,
    Converter25 as Converter25Template,
} from '../../../generated/templates'
import {
    ConverterUpgrader,
    ConverterOwned as ConverterOwnedEvent,
    ConverterUpgrade as ConverterUpgradeEvent,
    OwnerUpdate as OwnerUpdateEvent
} from '../../../generated/ConverterUpgrader-0xc724bc5f3dd616c8fadb75a23c00c13880a6268f/ConverterUpgrader'
import { log, BigDecimal, BigInt, Address } from '@graphprotocol/graph-ts'
import {ethereum} from '@graphprotocol/graph-ts/index';

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
        if (converter.type.equals(BigInt.fromI32(2))) {
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

        let reserveBalanceResult = converterContract.try_reserveStakedBalance(reserveTokenResult.value);
        let reserveWeightResult = converterContract.try_reserveWeight(reserveTokenResult.value);

        if (reserveBalanceResult.reverted || reserveWeightResult.reverted) {
            log.error("_updateReserveBalancesAndWeights contract calls reverted for converter {} and token {}", [
                id,
                reserveTokenResult.value.toHexString()
            ]);
            continue
        }

        let reserveToken = TokenEntity.load(reserveTokenResult.value.toHexString());
        if (reserveToken === null) {
            log.error("_updateReserveBalancesAndWeights token not found for converter {} and token {}", [
                id,
                reserveTokenResult.value.toHexString()
            ]);
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

class LiquidityPoolV1ConverterVersionInBytes extends LiquidityPoolV1Converter {
    static bind(address: Address): LiquidityPoolV1ConverterVersionInBytes {
        return new LiquidityPoolV1ConverterVersionInBytes("LiquidityPoolV1Converter", address);
    }
    try_version(): ethereum.CallResult<i32> {
        log.debug('try_version at address {}', [this._address.toHexString()]);
        let result = this.call("version", "version():(uint16)", []);

        if (result != null){
            let bytesValue = result[0];
            bytesValue.kind = ethereum.ValueKind.BYTES;

            let bytes = bytesValue.toBytes();
            log.debug('try_version result: {}', [bytes.toHexString()]);
            if (bytes.byteLength > 2){
                log.debug('try_version result is string: "{}". Set version to zero to skip.', [bytes.toString()]);
                return ethereum.CallResult.fromValue(0);
            } else {
                let versionInt = BigInt.fromUnsignedBytes(bytes);
                log.debug('try_version result is uint16', [versionInt.toString()]);
                return ethereum.CallResult.fromValue(versionInt.toI32());
            }

        } else {
            return new ethereum.CallResult();
        }

    }
}