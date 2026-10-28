import { NFTMarketplace } from "./core/nft.js"

const nft = new NFTMarketplace()

// Check all NFTs
const allNfts = nft.db.prepare("SELECT * FROM nfts").all()
console.log("All NFTs:", allNfts)

// Check all listings
const allListings = nft.db.prepare("SELECT * FROM nft_listings").all()
console.log("All listings:", allListings)

// Check listing for nftId=1
const listing = nft.getListingByNft(1)
console.log("Listing for nftId=1:", listing)
