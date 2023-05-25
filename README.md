A DAO contract that accepts proposals and votes for minting an NFT. 

This code is not production-ready and is missing many important checks. The sole purpose of this repo is to demonstrate some Algorand smart contract concepts such as box storage, ABI tuples, NameTuples, and contract-to-contract calling. 

# Setup
Clone this repository and run `algokit bootstrap all` to install necessary dependencies. 

# Running
From the `web/` directory, run `yarn serve` to compile the contracts serve the website. By default it will connect to a local network. Run `NETWORK=testnet yarn serve` to use testnet. 
