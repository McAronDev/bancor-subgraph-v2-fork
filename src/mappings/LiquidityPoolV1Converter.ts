import {
    LiquidityPoolV1Converter,
    Activation as ActivationEvent,
    Conversion as ConversionEvent,
    ConversionFeeUpdate as ConversionFeeUpdateEvent,
    LiquidityAdded as LiquidityAddedEvent,
    LiquidityRemoved as LiquidityRemovedEvent,
    OwnerUpdate as OwnerUpdateEvent,
    TokenRateUpdate as TokenRateUpdateEvent
} from '../../generated/templates/LiquidityPoolV1Converter/LiquidityPoolV1Converter'
import {
    ERC20Token
} from '../../generated/templates/LiquidityPoolV1Converter/ERC20Token'
import { 
    Converter as ConverterEntity,
    ConverterBalance as ConverterBalanceEntity,
    LiquidityProviderBalance as LiquidityProviderBalanceEntity,
    Swap as SwapEntity,
    Token as TokenEntity,
    VolumeStat as VolumeStatEntity,
} from '../../generated/schema'
import { log, BigDecimal, BigInt, Address } from '@graphprotocol/graph-ts'
import { 
    ETH_ADDRESS, 
    createAndReturnConverter, 
    createAndReturnPlatformStat,
    createAndReturnUser,
    createAndReturnConverterVolumeStat
} from './helpers'


export function handleActivation(event: ActivationEvent): void {
    let converter = createAndReturnConverter(event.address);
    converter.activated = event.params._activated;
    converter.save();
    // event.params._anchor
    // event.params._type

    let platform = createAndReturnPlatformStat();
    platform.numActiveConverters = event.params._activated ? platform.numActiveConverters.plus(BigInt.fromI32(1)) : platform.numActiveConverters.minus(BigInt.fromI32(1))
    platform.save();

    _updateReserveBalancesAndWeights(event.address)
}

export function handleConversion(event: ConversionEvent): void {
    let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();

    let converter = createAndReturnConverter(event.address);
    let user = createAndReturnUser(event.params._trader);
    let fromToken = createAndReturnToken(event.params._fromToken);
    let toToken = createAndReturnToken(event.params._toToken);

    let swap = SwapEntity.load(id);
    if (swap === null) {
        swap = new SwapEntity(id);
        swap.converter = converter.id;
        swap.fromToken = fromToken.id;
        swap.fromAmount = event.params._amount.divDecimal((BigInt.fromI32(10).pow(fromToken.decimals.toI32() as u8).toBigDecimal()));
        swap.toToken = toToken.id;
        swap.toAmount = event.params._return.divDecimal((BigInt.fromI32(10).pow(toToken.decimals.toI32() as u8).toBigDecimal()));
        swap.conversionFee = event.params._conversionFee.divDecimal((BigInt.fromI32(10).pow(toToken.decimals.toI32() as u8).toBigDecimal()));
        swap.trader = user.id;
        swap.txFrom = event.transaction.from.toHexString();
        swap.txTo = event.transaction.to.toHexString();
        swap.createdAtBlockNumber = event.block.number;
        swap.createdAtLogIndex = event.logIndex;
        swap.createdAtTimestamp = event.block.timestamp;
        swap.createdAtTransaction = event.transaction.hash.toHexString();

        if (swap.fromAmount.equals(BigDecimal.fromString("0.0"))) {
            swap.price = BigDecimal.fromString("0.0");
        }
        else {
            swap.price = swap.fromAmount.div(swap.toAmount);
        }

        swap.save()

        let platform = createAndReturnPlatformStat();
        platform.swaps = platform.swaps.plus(BigInt.fromI32(1));
        platform.save()

        converter.numSwaps = converter.numSwaps.plus(BigInt.fromI32(1));
        converter.save()
    }

    // From token volume
    let volumeStat = createAndReturnConverterVolumeStat(event.address, event.params._fromToken);
    volumeStat.sellVolume = volumeStat.sellVolume.plus(
        event.params._amount.divDecimal((BigInt.fromI32(10).pow(fromToken.decimals.toI32() as u8).toBigDecimal()))
    );
    volumeStat.totalVolume = volumeStat.totalVolume.plus(
        event.params._amount.divDecimal((BigInt.fromI32(10).pow(fromToken.decimals.toI32() as u8).toBigDecimal()))
    );
    volumeStat.save();

    // volumeStat = _createAndReturnTokenVolumeStat(event.params._fromToken);
    // volumeStat.sellVolume = volumeStat.sellVolume.plus(
    //     event.params._amount.divDecimal((BigInt.fromI32(10).pow(fromToken.decimals.toI32() as u8).toBigDecimal()))
    // );
    // volumeStat.totalVolume = volumeStat.totalVolume.plus(
    //     event.params._amount.divDecimal((BigInt.fromI32(10).pow(fromToken.decimals.toI32() as u8).toBigDecimal()))
    // );
    // volumeStat.save();

    // To token volume
    volumeStat = createAndReturnConverterVolumeStat(event.address, event.params._toToken);
    volumeStat.buyVolume = volumeStat.buyVolume.plus(
        event.params._return.divDecimal((BigInt.fromI32(10).pow(toToken.decimals.toI32() as u8).toBigDecimal()))
    );
    volumeStat.totalVolume = volumeStat.totalVolume.plus(
        event.params._return.divDecimal((BigInt.fromI32(10).pow(toToken.decimals.toI32() as u8).toBigDecimal()))
    );
    volumeStat.save();

    // volumeStat = _createAndReturnTokenVolumeStat(event.params._toToken);
    // volumeStat.buyVolume = volumeStat.buyVolume.plus(
    //     event.params._amount.divDecimal((BigInt.fromI32(10).pow(toToken.decimals.toI32() as u8).toBigDecimal()))
    // );
    // volumeStat.totalVolume = volumeStat.totalVolume.plus(
    //     event.params._amount.divDecimal((BigInt.fromI32(10).pow(toToken.decimals.toI32() as u8).toBigDecimal()))
    // );
    // volumeStat.save();

    // Update token balances
    _updateReserveBalancesAndWeights(event.address);
}

export function handleConversionFeeUpdate(event: ConversionFeeUpdateEvent): void {
    let converter = createAndReturnConverter(event.address);
    converter.conversionFee = event.params._newFee.divDecimal(BigDecimal.fromString("1000000")); // Conversion fee is given in ppm
    converter.save()
}

export function handleLiquidityAdded(event: LiquidityAddedEvent): void {
    let user = createAndReturnUser(event.params._provider);
    let token = createAndReturnToken(event.params._reserveToken);
    let converter = createAndReturnConverter(event.address);
    let converterBalance = _createAndReturnConverterBalance(event.address, event.params._reserveToken);

    // Update pool token supply
    // TODO

    // Update LP balance
    // TODO

    // Update token balances & pool token share value
    _updateReserveBalancesAndWeights(event.address);
}

export function handleLiquidityRemoved(event: LiquidityRemovedEvent): void {
    let user = createAndReturnUser(event.params._provider);
    let token = createAndReturnToken(event.params._reserveToken);
    let converter = createAndReturnConverter(event.address);
    let converterBalance = _createAndReturnConverterBalance(event.address, event.params._reserveToken);


    // Update pool token supply
    // TODO

    // Update LP balance
    // TODO

    // Update token balances
    _updateReserveBalancesAndWeights(event.address);
}

export function handleOwnerUpdate(event: OwnerUpdateEvent): void {
    let id = event.address.toHexString();
    let debug_id = event.transaction.hash.toHexString();
    let newOwner = event.params._newOwner.toHexString();
    let prevOwner = event.params._prevOwner.toHexString();
    log.debug("handleOwnerUpdate {} tx: {} new: {} old: {}", [
        id, debug_id, newOwner, prevOwner
    ])
}

export function handleTokenRateUpdate(event: TokenRateUpdateEvent): void {
    log.debug("handleTokenRateUpdate {} {} {} {}", [
        event.params._token1.toHexString(),
        event.params._rateN.toString(),
        event.params._token2.toHexString(),
        event.params._rateD.toString()
    ])
}

function _createAndReturnConverterBalance(converterAddress: Address, tokenAddress: Address): ConverterBalanceEntity {
    let id = converterAddress.toHexString() + "-" + tokenAddress.toHexString();
    let converterBalance = ConverterBalanceEntity.load(id);
    if (converterBalance === null) {
        // Create converter balance
        converterBalance = new ConverterBalanceEntity(id);
        converterBalance.converter = converterAddress.toHexString();
        converterBalance.token = tokenAddress.toHexString();
        converterBalance.stakedAmount = BigDecimal.fromString("0.0");
        converterBalance.balance = BigDecimal.fromString("0.0");
        converterBalance.weight = BigDecimal.fromString("0.0");
        converterBalance.save();
    }
    return converterBalance!
}

function createAndReturnToken(tokenAddress: Address): TokenEntity {
    let id = tokenAddress.toHexString();
    let token = TokenEntity.load(id);
    if (token === null) {
        if (id != ETH_ADDRESS) {
            let tokenContract = ERC20Token.bind(tokenAddress);
            let nameResult = tokenContract.try_name();
            let symbolResult = tokenContract.try_symbol();
            let decimalsResult = tokenContract.try_decimals();

            token = new TokenEntity(id);
            token.name = nameResult.reverted ? "" : nameResult.value
            token.symbol = symbolResult.reverted ? "" : symbolResult.value
            token.decimals = decimalsResult.reverted ? BigInt.fromI32(0) : BigInt.fromI32(decimalsResult.value)
            token.save()
        } 
        else {
            token = new TokenEntity(id);
            token.name = "ether"
            token.symbol = "ETH"
            token.decimals = BigInt.fromI32(18)
            token.save()
        }
    }
    return token!
}

function _updateReserveBalancesAndWeights(converterAddress: Address): void {
    let id = converterAddress.toHexString();
    let converterContract = LiquidityPoolV1Converter.bind(converterAddress);

    let converter = ConverterEntity.load(id);
    if (converter === null) {
        log.warning("_updateReserveBalancesAndWeights Converter not found {}", [id])
        return
    }

    
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
        let reserveWeightResult = converterContract.try_reserveWeight(reserveTokenResult.value);
        
        if (reserveBalanceResult.reverted || reserveWeightResult.reverted) {
            log.error("_updateReserveBalancesAndWeights contract calls reverted for converter {} and token {}", [
                id,
                reserveTokenResult.value.toHexString()
            ]);
            continue
        }

        let reserveToken = createAndReturnToken(reserveTokenResult.value);
        let converterBalance = _createAndReturnConverterBalance(converterAddress, reserveTokenResult.value);

        // Update converter actual balance
        if (reserveTokenResult.value.toHexString() != '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'){
            let reserveTokenContract = ERC20Token.bind(reserveTokenResult.value);
            let balanceOf = reserveTokenContract.try_balanceOf(converterAddress);
            if (!balanceOf.reverted) {
                converterBalance.balance = balanceOf.value.divDecimal((BigInt.fromI32(10).pow(reserveToken.decimals.toI32() as u8).toBigDecimal()));
            }
            else {
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

        // Update converter staked reserve balance
        converterBalance.weight = reserveWeightResult.value.divDecimal(BigDecimal.fromString("1000000")); // Weight is given in ppm
        converterBalance.save()

        // Calculate shareValue
        // TODO

        i = i.plus(BigInt.fromI32(1));
    }
}