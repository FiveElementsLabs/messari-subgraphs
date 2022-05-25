import { Address } from "@graphprotocol/graph-ts";
import { CustomPriceType } from "../common/types";
import { ChainlinkOracle } from "../../../generated/ExampleVault/ChainlinkOracle";
import oracles from "./oracles";
import { ERC20 } from "../../../generated/ExampleVault/ERC20";

console.log(oracles[0].address);

export function getChainLinkContract(asset: string, network: string): any {
  for (let i = 0; i < oracles.length; i++) {
    if (oracles[i].asset === asset) {
      return ChainlinkOracle.bind(Address.fromString(oracles[i].address));
    }
  }
  return undefined;
}

export function getTokenPriceFromChainLink(
  tokenAddr: Address,
  network: string
): CustomPriceType {
  const tokenContract = ERC20.bind(tokenAddr);
  const symbol = tokenContract.symbol();
  const chainLinkContract = getChainLinkContract(symbol, network);

  if (!chainLinkContract) {
    return new CustomPriceType();
  }
  let result = chainLinkContract.try_getLatestRoundData(tokenAddr);

  if (!result.reverted) {
    const decimals = tokenContract.decimals();

    return CustomPriceType.initialize(
      result.value.value1.toBigDecimal(),
      decimals
    );
  }

  return new CustomPriceType();
}
