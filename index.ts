import { exit } from "process";
import { AdvisorInfo, scrape } from "./scrape.js";
import * as readline from "readline/promises";
import { mkdir, writeFile, access, constants, readFile } from "fs/promises";
import { stringify } from "csv/sync";
import { resolve } from "path";
import { formatISO9075 } from "date-fns";
import puppeteer from "puppeteer";

async function main() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const usingZipList =
        (await rl.question("Are you using a zip code list? (y/n) ")).trim() ===
        "y";
    let zipList: string[] = [];
    if (usingZipList) {
        const zipListFile = resolve(
            (await rl.question("Enter file path: ")).trim()
        );
        zipList = (await readFile(zipListFile))
            .toString()
            .trim()
            .split(/\r?\n/g)
            .map((z) => z.trim());
        for (const z of zipList) {
            if (z.match(/^\d{5}$/) === null) {
                console.log("Error: not a valid zip code");
                exit(1);
            }
        }
    } else {
        const zip = (await rl.question("Enter zip code: ")).trim();
        if (zip.match(/\d{5}/) === null) {
            console.log("Error: not a valid zip code");
            exit(1);
        }
        zipList.push(zip);
    }
    zipList = Array.from(new Set(zipList))
    console.log(zipList);

    let advisors: AdvisorInfo[] = [];
    const browser = await puppeteer.launch({timeout: 0});
    for (let zip of zipList) {
        console.log(`Scraping for ${zip}`);
        advisors.push(...(await scrape(zip, browser)));
    }
    await browser.close();
    advisors = [... new Map(advisors.map(advisor => [advisor.name, advisor])).values()]

    const fileName = `advisors ${formatISO9075(new Date()).replaceAll(
        ":",
        "-"
    )}`;

    try {
        await access("results", constants.F_OK);
    } catch (_) {
        await mkdir("results");
    }
    try {
        await access("results/json", constants.F_OK);
    } catch (_) {
        await mkdir("results/json");
    }
    await writeFile(
        `results/json/${fileName}.json`,
        JSON.stringify(advisors, null, 2)
    );

    const advisorStrings = advisors.map((advisor) => [
        advisor.name,
        advisor.email ?? "",
        advisor.address ?? "",
        advisor.city ?? "",
        advisor.state ?? "",
        advisor.phoneNo ?? "",
        ...(advisor.sites ?? [""]),
    ]);
    const csv = stringify([
        [
            "Name",
            "Email",
            "Address",
            "City",
            "State",
            "Phone Number",
            "Website(s)",
        ],
        ...advisorStrings,
    ]);
    try {
        await access("results/csv", constants.F_OK);
    } catch (_) {
        await mkdir("results/csv");
    }
    await writeFile(`results/csv/${fileName}.csv`, csv);
    const finalFileLocation = resolve(`results/csv/${fileName}.csv`);

    console.log(
        `Finished successfully! Your csv file is at ${finalFileLocation}`
    );

    exit();
}

main();
