// scripts/deploy.js
// Run: npx hardhat run scripts/deploy.js --network base

const hre = require("hardhat");

async function main() {
  console.log("Deploying AgentDrop to Base...");

  // USDC contract address on Base mainnet
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  // Get your wallet address (this becomes the agent address initially)
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying from:", deployer.address);

  const AgentDrop = await hre.ethers.getContractFactory("AgentDrop");
  const contract = await AgentDrop.deploy(USDC_BASE, deployer.address);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("✅ AgentDrop deployed to:", address);
  console.log("Save this address — you need it in your .env file!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
