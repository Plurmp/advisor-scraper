import puppeteer, { Browser, TimeoutError } from "puppeteer";
import * as cheerio from "cheerio";
import { Promise as BluePromise } from "bluebird";

export interface AdvisorInfo {
    name: string;
    address: string;
    phoneNo: string;
    sites: string[];
}

export async function scrape(zip: string): Promise<AdvisorInfo[]> {
    const browser = await puppeteer.launch();
    let advisorFinders = [
        scrapeEdwardJones,
    ];
    return (await Promise.all(
        advisorFinders.map(
            (fun) => fun(zip, browser),
        ),
    )).flat();
}

async function scrapeEdwardJones(
    zip: string,
    browser: Browser,
): Promise<AdvisorInfo[]> {
    const urlObject = new URL(
        "https://www.edwardjones.com/us-en/search/find-a-financial-advisor",
    );
    urlObject.searchParams.set("fasearch", zip);
    urlObject.searchParams.set("searchtype", "2");

    const page = await browser.newPage();
    await page.goto(urlObject.toString());
    await page.waitForSelector('span.text-sm[tabindex="-1"]');
    const html = await page.content();
    const $ = cheerio.load(html);
    await page.close();

    const totalResults =
        +($('span.text-sm[tabindex="-1"]').text().match(/of (\d+) Results/)?.[1] ??
            0);
    const searchPages = Array.from(
        { length: Math.ceil(totalResults / 16) + 1 },
        (_, i) => {
            urlObject.searchParams.set("page", i.toString());
            return urlObject.toString();
        },
    );
    console.log(searchPages);
    const jobPages = (await BluePromise.map(
        searchPages,
        async (searchPage: string) =>
            await scrapeEdwardJonesSearchPage(searchPage, browser),
        { concurrency: 10 }
    )).flat();
    console.log(jobPages.length);


    return [];
}

async function scrapeEdwardJonesSearchPage(
    url: string,
    browser: Browser,
    retries = 0,
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

    return $("div.flex.h-full div.flex-1 h3 a").map(
        (_, el) => "https://www.edwardjones.com" + el.attribs["href"],
    ).toArray();
}

async function scrapeEdwardJonesPage(url: string, browser: Browser): Promise<AdvisorInfo[]> {

}
