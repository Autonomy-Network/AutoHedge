
const hre = require('hardhat');

const { ethers, network } = hre;

// ----------------------------
//      MAIN DEPLOY CODE     //
// ----------------------------

async function main() {

  const startTime = performance.now();

  const [ owner ] = await ethers.provider.listAccounts();
  
  const startBalance = await ethers.provider.getBalance(owner);


  const uniswapLpTokenPriceOracleFactory = await ethers.getContractFactory('UniswapLpTokenPriceOracle')

  console.log('deploying Uniswap LP Token Price Oracle....');
  const uniswapLpTokenPriceOracle = await uniswapLpTokenPriceOracleFactory.deploy();
  console.log('\t', uniswapLpTokenPriceOracle.address);
  await uniswapLpTokenPriceOracle.deployTransaction.wait();
  console.log('\tdeployed');

  console.log('\nAll Contract Deployed!');

  if (network.name === 'hardhat') {
  console.log('Network: Hardhat => skipping contract source code verification.\n');
  } else {

    await uniswapLpTokenPriceOracle.deployTransaction.wait(5); // wait some time to be sure etherscan has processed the deploy

    console.log('Start verification on Etherscan...\n');

    await hre.run('verify:verify', {
      address: uniswapLpTokenPriceOracle.address,
      constructorArguments: [],
    }).catch(e => { console.log('Uniswap LP Token Price Oracle: Verification Failed'); console.error(e); });
  }

  const endTime = performance.now();
  const endBalance = await ethers.provider.getBalance(owner);

  console.table([
    { contract: 'Uniswap LP Token Price Oracle', address: uniswapLpTokenPriceOracle.address },
  ]);

  console.log(`\nDuration: ${(endTime - startTime) / 1000}s`);
  console.log(`\nTotal cost: ${ethers.utils.formatEther(startBalance.sub(endBalance))}${ethers.constants.EtherSymbol}`);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
.then(() => process.exit(0))
.catch((error) => {
    console.error(error)
    process.exit(1)
})
