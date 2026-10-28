import { NFTMarketplace } from "./core/nft.js"

const nft = new NFTMarketplace()

// Mint a new NFT
const created = nft.mint("test-buyer", "ipfs://debug")
console.log("Minted NFT:", created)

// List it
const listing = nft.list(created.id, "test-buyer", 1000n)
console.log("Listing:", listing)

// Check DB
const allListings = nft.db.prepare("SELECT * FROM nft_listings").all()
console.log("All listings:", allListings)
