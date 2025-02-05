import puppeteer, { Browser, TimeoutError } from "puppeteer";
import * as cheerio from "cheerio";
import bluebird from "bluebird";
const { Promise: BluePromise } = bluebird;
import { writeFile } from "fs/promises";

export interface AdvisorInfo {
    name: string;
    email?: string;
    address?: string;
    phoneNo?: string;
    sites: string[];
}

interface FinancialService {
    name: string;
    telephone: string;
    address: {
        streetAddress: string;
        addressLocality: string;
        addressRegion: string;
        postalCode: string;
        addressCountry: string;
    };
    url: string;
    sameAs: string[];
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function scrape(zip: string): Promise<AdvisorInfo[]> {
    const browser = await puppeteer.launch();
    let advisorFinders = [
        // scrapeEdwardJones, // RATE LIMITED
        // scrapeAmeripriseAdvisors,
        scrapeStifel,
    ];
    return (
        await Promise.all(advisorFinders.map((fun) => fun(zip, browser)))
    ).flat();
}

async function scrapeEdwardJones(
    zip: string,
    browser: Browser
): Promise<AdvisorInfo[]> {
    const urlObject = new URL(
        "https://www.edwardjones.com/us-en/search/find-a-financial-advisor"
    );
    urlObject.searchParams.set("fasearch", zip);
    urlObject.searchParams.set("searchtype", "2");

    const page = await browser.newPage();
    await page.goto(urlObject.toString());
    await page.waitForSelector('span.text-sm[tabindex="-1"]');
    const html = await page.content();
    const $ = cheerio.load(html);
    await page.close();

    const totalResults = +(
        $('span.text-sm[tabindex="-1"]')
            .text()
            .match(/of (\d+) Results/)?.[1] ?? 0
    );
    const searchPages = Array.from(
        { length: Math.ceil(totalResults / 16) + 1 },
        (_, i) => {
            urlObject.searchParams.set("page", i.toString());
            return urlObject.toString();
        }
    );
    console.log(searchPages);
    const jobPages = (
        await BluePromise.map(
            searchPages,
            async (searchPage: string) =>
                await scrapeEdwardJonesSearchPage(searchPage, browser),
            { concurrency: 10 }
        )
    ).flat();
    console.log(jobPages.length);

    return [];
}

async function scrapeEdwardJonesSearchPage(
    url: string,
    browser: Browser,
    retries = 0
): Promise<string[]> {
    if (retries > 5) {
        console.log(`Retries on ${url} exceeding 5, aborting...`);
        return [];
    }

    const page = await browser.newPage();
    try {
        await page.goto(url);
        await page.waitForSelector("div.flex.h-full");
    } catch (e) {
        if (e instanceof TimeoutError) {
            console.log(`TimeoutError on ${url}, retrying (${retries})...`);
            return scrapeEdwardJonesSearchPage(url, browser, retries + 1);
        }
    }
    const html = await page.content();
    const $ = cheerio.load(html);
    await page.close();

    return $("div.flex.h-full div.flex-1 h3 a")
        .map((_, el) => "https://www.edwardjones.com" + el.attribs["href"])
        .toArray();
}

// async function scrapeEdwardJonesPage(url: string, browser: Browser): Promise<AdvisorInfo[]> {

// }

async function scrapeAmeripriseAdvisors(
    zip: string,
    browser: Browser,
    retries = 0
): Promise<AdvisorInfo[]> {
    if (retries === 0) {
        console.log("Scraping Ameriprise Advisors...");
    } else if (retries > 5) {
        console.log(`Retries on Ameriprise exceeding 5, aborting...`);
        return [];
    }

    const url = `https://www.ameripriseadvisors.com/#search?crit=%7Bse%3Adefault%3Bnrr%3A6%3Bsri%3A0%3Brd%3A5%3Bst%3Azip%20code%3Blt%3A0%3Blg%3A0%3Bt%3A${zip}%7D&page=0`;

    const page = await browser.newPage();
    try {
        await page.goto(url);
        await page.waitForSelector("div.card-main-container");
    } catch (e) {
        console.log(`TimeoutError on Ameriprise, retrying (${retries})...`);
        return scrapeAmeripriseAdvisors(zip, browser, retries + 1);
    }

    for (
        let bh = await page.$("button.load-more-results");
        bh !== null && (await bh.isVisible());
        bh = await page.$("button.load-more-results")
    ) {
        await bh.evaluate((b) => b.click());
        await delay(500);
    }

    const html = await page.content();
    const $ = cheerio.load(html);
    await page.close();

    const advisorPages = $("div.card-main-container a.visit-button")
        .map(
            (_, el) => "https://www.ameripriseadvisors.com" + el.attribs["href"]
        )
        .toArray();

    // console.log(advisorPages);

    return (
        await BluePromise.map(
            advisorPages,
            async (advisorPage) =>
                await scrapeAmeripriseAdvisorsPage(advisorPage),
            { concurrency: 32 }
        )
    ).filter((a): a is AdvisorInfo => !!a);
}

async function scrapeAmeripriseAdvisorsPage(
    url: string,
    retries = 0
): Promise<AdvisorInfo | undefined> {
    if (retries > 5) {
        console.log(`Retries on ${url} exceeding 5, aborting...`);
        return undefined;
    }

    let html = "";
    try {
        html = await (await fetch(url)).text();
    } catch (e) {
        if (e instanceof TypeError) {
            console.log(`Fetch on ${url} failed, retrying(${retries})...`);
            return scrapeAmeripriseAdvisorsPage(url, retries + 1);
        }
    }
    const $ = cheerio.load(html);

    let unparsedJson = $('script[type="application/ld+json"]')
        .filter((_, el) => {
            const ldJson = JSON.parse($(el).text());
            return ldJson["@type"] === "FinancialService" || !!ldJson["@graph"];
        })
        .first()
        .text();
    await writeFile("scrap1.json", unparsedJson);
    let financialService = <FinancialService>{};
    const parsedJson = JSON.parse(unparsedJson);
    if (!!parsedJson["@graph"]) {
        financialService = (parsedJson["@graph"] as any[]).filter(
            (schema) => schema["@type"] === "FinancialService"
        )[0] as FinancialService;
    } else {
        financialService = JSON.parse(unparsedJson) as FinancialService;
    }

    const address = [
        financialService.address.streetAddress,
        financialService.address.addressLocality,
        financialService.address.addressRegion,
        financialService.address.postalCode,
        financialService.address.addressCountry,
    ]
        .filter((addrPart) => addrPart.length > 0)
        .join(", ");
    const email = $("ul.email-phone > li > a.phone-email")
        .filter((_, el) => el.attribs["href"].startsWith("mailto:"))
        .first()
        .attr("href")
        ?.substring(7);

    return {
        name: financialService.name.replace(
            " - Ameriprise Financial Services, LLC",
            ""
        ),
        email,
        address,
        phoneNo: financialService.telephone,
        sites: [financialService.url, ...financialService.sameAs].filter(
            (site) => site.length > 0
        ),
    };
}

async function scrapeStifel(
    zip: string,
    browser: Browser
): Promise<AdvisorInfo[]> {
    console.log("Scraping Stifel...");
    
    let url = `https://www.stifel.com/fa/search?zipcode=${zip}&distance=20`;

    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForSelector("a.search-results-fa-link");
    let advisorPages = await page.$$eval("a.search-results-fa-link", (elems) =>
        elems.map((elem) => elem.href)
    );
    for (
        let nextPage = await page.$("input#btnNextPage");
        nextPage !== null;
        nextPage = await page.$("input#btnNextPage")
    ) {
        await nextPage.evaluate((np) => np.click());
        await page.waitForSelector("a.search-results-fa-link");
        advisorPages = advisorPages.concat(
            await page.$$eval("a.search-results-fa-link", (elems) =>
                elems.map((elem) => elem.href)
            )
        );
    }
    await page.close()
    // console.log(advisorPages);

    return await BluePromise.map(
        advisorPages,
        async (advisorPage) => await scrapeStifelPage(advisorPage, browser),
        { concurrency: 32 }
    );
}

export async function scrapeStifelPage(
    url: string,
    browser: Browser,
): Promise<AdvisorInfo> {
    let html = await (await fetch(url)).text();
    let $ = cheerio.load(html);

    if ($("span.fa-landing-name").length === 0) {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForSelector("span.fa-landing-name");
        html = await page.content();
        $ = cheerio.load(html);
        await page.close();
    }

    const name = $("span.fa-landing-name").text();
    const phoneNo = $("dd.fa-landing-phone-desktop")
        .text()
        .replaceAll(/\D/g, "");
    const address = $("div.fa-landing-address dd")
        .slice(1, -1)
        .map((_, el) => $(el).text().trim())
        .toArray()
        .join(", ");
    const sites = [new URL(url).origin + new URL(url).pathname];
    
    return {
        name,
        phoneNo,
        address,
        sites,
    };
}
