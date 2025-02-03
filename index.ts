import { exit } from "process";
import { AdvisorInfo, scrape } from "./scrape";
import * as readline from "readline/promises";

async function main() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    let zip = (await rl.question("Enter zip code: ")).trim();
    if (zip.match(/\d{5}/) === null) {
        console.log("Error: not a valid zip code");
        exit(1);
    }

    await scrape(zip);

    exit()
}

main();