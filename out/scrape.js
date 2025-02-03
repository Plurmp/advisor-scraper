"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrape = void 0;
const puppeteer_1 = __importStar(require("puppeteer"));
const cheerio = __importStar(require("cheerio"));
const bluebird_1 = require("bluebird");
async function scrape(zip) {
    const browser = await puppeteer_1.default.launch();
    let advisorFinders = [
        scrapeEdwardJones,
    ];
    return (await Promise.all(advisorFinders.map((fun) => fun(zip, browser)))).flat();
}
exports.scrape = scrape;
async function scrapeEdwardJones(zip, browser) {
    const urlObject = new URL("https://www.edwardjones.com/us-en/search/find-a-financial-advisor");
    urlObject.searchParams.set("fasearch", zip);
    urlObject.searchParams.set("searchtype", "2");
    const page = await browser.newPage();
    await page.goto(urlObject.toString());
    await page.waitForSelector('span.text-sm[tabindex="-1"]');
    const html = await page.content();
    const $ = cheerio.load(html);
    await page.close();
    const totalResults = +($('span.text-sm[tabindex="-1"]').text().match(/of (\d+) Results/)?.[1] ??
        0);
    const searchPages = Array.from({ length: Math.ceil(totalResults / 16) + 1 }, (_, i) => {
        urlObject.searchParams.set("page", i.toString());
        return urlObject.toString();
    });
    console.log(searchPages);
    const jobPages = (await bluebird_1.Promise.map(searchPages, async (searchPage) => await scrapeEdwardJonesSearchPage(searchPage, browser), { concurrency: 10 })).flat();
    console.log(jobPages.length);
    return [];
}
async function scrapeEdwardJonesSearchPage(url, browser, retries = 0) {
    if (retries > 5) {
        console.log(`Retries on ${url} exceeding 5, aborting...`);
        return [];
    }
    const page = await browser.newPage();
    try {
        await page.goto(url);
        await page.waitForSelector("div.flex.h-full");
    }
    catch (e) {
        if (e instanceof puppeteer_1.TimeoutError) {
            console.log(`TimeoutError on ${url}, retrying (${retries})...`);
            return scrapeEdwardJonesSearchPage(url, browser, retries + 1);
        }
    }
    const html = await page.content();
    const $ = cheerio.load(html);
    await page.close();
    return $("div.flex.h-full div.flex-1 h3 a").map((_, el) => "https://www.edwardjones.com" + el.attribs["href"]).toArray();
}
async function scrapeEdwardJonesPage(url, browser) {
}
//# sourceMappingURL=scrape.js.map