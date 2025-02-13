import puppeteer, { Browser, TimeoutError } from "puppeteer";
import * as cheerio from "cheerio";
import bluebird from "bluebird";
const { Promise: BluePromise } = bluebird;
import { writeFile } from "fs/promises";

export interface AdvisorInfo {
    name: string;
    email?: string;
    address?: string;
    city?: string;
    state?: string;
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

interface EdwardJonesResults {
    results: EdwardJonesAdvisor[];
}

interface EdwardJonesAdvisor {
    faName: string;
    address: string;
    faCity: string;
    faState: string;
    phone: string;
    faUrl: string;
    socialMedia:
        | {
              [key: string]: string
          }[]
        | "";
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function scrape(zip: string): Promise<AdvisorInfo[]> {
    const browser = await puppeteer.launch();
    let advisorFinders = [
        scrapeEdwardJones, // RATE LIMITED
        scrapeAmeripriseAdvisors,
        scrapeStifel,
        // scrapeJanney, // BLOCKED
        // scrapeRaymondJames, // LOAD EACH ADVISOR
        scrapeSchwab,
        scrapeLPL,
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
    await page.waitForSelector("button#tabs--2--tab--1");
    await page.click("button#tabs--2--tab--1");
    const edResponse = await page.waitForResponse(
        (response) =>
            response.url().includes("pageSize=200") 
    );
    const jsonString = Buffer.from(await edResponse.content()).toString(
        "utf-8"
    );
    const edResults = JSON.parse(jsonString) as EdwardJonesResults;
    
    return edResults.results.map((advisor) => {
        let sites = ["https://www.edwardjones.com" + advisor.faUrl];
        if (advisor.socialMedia !== "") {
            advisor.socialMedia.forEach((thisSite) => {
                for (const k in thisSite) {
                    sites.push(thisSite[k])
                }
            });
        }
        return <AdvisorInfo>{
            name: advisor.faName,
            address: advisor.address.replace(/, [^,]+, \w{2} \d{5}/, ""),
            phoneNo: advisor.phone,
            city: advisor.faCity,
            state: advisor.faState,
            sites,
        };
    });
}

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
            { concurrency: 20 }
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
        address: financialService.address.streetAddress,
        city: financialService.address.addressLocality,
        state: financialService.address.addressRegion,
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
    await page.close();
    // console.log(advisorPages);

    return await BluePromise.map(
        advisorPages,
        async (advisorPage) => await scrapeStifelPage(advisorPage, browser),
        { concurrency: 20 }
    );
}

export async function scrapeStifelPage(
    url: string,
    browser: Browser
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
        .first()
        .text()
        .replaceAll(/\D/g, "");
    const address = $("div.fa-landing-address dd")
        .slice(1, -2)
        .map((_, el) => $(el).text().trim())
        .toArray()
        .join(", ");
    const matchArray = $($("div.fa-landing-address dd").get(-2))
        .text()
        .match(/(?<city>\w+), (?<state>\w+)/);
    const city = matchArray?.groups?.["city"];
    const state = matchArray?.groups?.["state"];
    const sites = [new URL(url).origin + new URL(url).pathname];

    return {
        name,
        phoneNo,
        address,
        city,
        state,
        sites,
    };
}

async function scrapeJanney(zip: string, _: Browser): Promise<AdvisorInfo[]> {
    const newBrowser = await puppeteer.launch({ headless: false });
    const page = await newBrowser.newPage();
    await page.goto(
        "https://www.janney.com/wealth-management/how-we-work-with-you/find-a-financial-advisor"
    );
    await writeFile("scrap.html", await page.content());
    await page.waitForSelector("input#SearchZip");
    await page.type("input#SearchZip", zip, { delay: 100 });
    await page.click("div.jcom-form-group:nth-child(4) > button:nth-child(1)");
    await page.waitForSelector("li.jcom-person-card");
    const html = await page.content();
    const $ = cheerio.load(html);
    await page.close();
    await newBrowser.close();

    const advisors = $("li.jcom-person-card")
        .map((_, card) => {
            const $cardContent = $(card).find("div.jcom-card-content");
            const name = $cardContent.find("h3.jcom-person-card-name").text();
            const email = $cardContent
                .find("i.jcom-icon--email")
                .parent()
                .text();
            const phoneNo = $cardContent
                .find("i.jcom-icon--phone")
                .parent()
                .text();
            const address = $cardContent
                .find("i.jcom-icon--location")
                .parent()
                .text();
            const sites = [
                "https://www.janney.com" + $cardContent.find("a").attr("href"),
            ];

            return <AdvisorInfo>{
                name,
                email,
                phoneNo,
                address,
                sites,
            };
        })
        .toArray();
    console.log(advisors[0]);

    return [];
}

async function scrapeRaymondJames(
    zip: string,
    browser: Browser
): Promise<AdvisorInfo[]> {
    console.log("Scraping Raymond James...");
    const url = `https://www.raymondjames.com/find-an-advisor?citystatezip=${zip}`;

    const newBrowser = await puppeteer.launch({ headless: false });
    const page = await newBrowser.newPage();
    await page.goto(url);
    await page.waitForSelector("li.faa-result");

    let html = await page.content();
    let $ = cheerio.load(html);
    let advisors: AdvisorInfo[] = [];
    while (true) {
        html = await page.content();
        $ = cheerio.load(html);
        const theseAdvisors = $("li.faa-result")
            .map((_, branch) => {
                const $branch = $(branch);
                const address = $branch
                    .find("div.location-address span")
                    .slice(0, -1)
                    .map((_, el) => $(el).text())
                    .toArray()
                    .join(", ");
                const matchArray = $branch
                    .find("div.location-address span:last-child")
                    .text()
                    .match(/(?<city>\w+), (?<state>\w+)/);
                const city = matchArray?.groups?.city;
                const state = matchArray?.groups?.state;
                const defaultPhone = $branch
                    .find("a.location-phone")
                    .text()
                    .replace(".", "");
                console.log($("div.faa-location-advisor").length);
                const thisBranch = $branch
                    .find("div.faa-location-advisor")
                    .map((_, advisor) => {
                        const $advisor = $(advisor);
                        const name = $advisor
                            .find("div.media-body > a:nth-child(1)")
                            .text();
                        const phoneNo =
                            $advisor.find("a.advisor-phone").length > 1
                                ? $advisor
                                      .find("a.advisor-phone")
                                      .text()
                                      .replace(".", "")
                                : defaultPhone;
                        const sites = [
                            $advisor
                                .find("div.media-body > a:nth-child(1)")
                                .attr("href") ?? "",
                            ...$advisor
                                .find("div.advisor-links > a")
                                .map((_, el) => el.attribs["href"])
                                .toArray(),
                        ].map((advisorLink) => {
                            if (advisorLink.indexOf("http") !== 0) {
                                return (
                                    "https://www.raymondjames.com" + advisorLink
                                );
                            } else {
                                return advisorLink;
                            }
                        });
                        const advisorInfo = <AdvisorInfo>{
                            name,
                            phoneNo,
                            address,
                            city,
                            state,
                            sites,
                        };
                        console.log("GETS TO THIS POINT");
                        return advisorInfo;
                    })
                    .toArray();
                // console.log(thisBranch);
                return thisBranch;
            })
            .toArray()
            .flat();
        // console.log(theseAdvisors);
        const nextButton = await page.$("button.next");
        if (nextButton === null || (await nextButton.isHidden())) {
            break;
        } else {
            await nextButton.click();
            await page.waitForSelector("li.faa-result");
        }
    }
    await page.close();

    return advisors;
}

async function scrapeSchwab(
    zip: string,
    browser: Browser
): Promise<AdvisorInfo[]> {
    const page = await browser.newPage();
    await page.goto(`https://client.schwab.com/public/consultant/find`, {
        timeout: 60_000,
    });
    await page.waitForSelector("input#txtAddr");
    await page.type("input#txtAddr", zip, { delay: 100 });
    await page.click("input#btn_LocateByZip");
    await page.waitForSelector("div#fcResult");
    const html = await page.content();
    const $ = cheerio.load(html);

    const advisorLinks = $("div#widgetlinks > span:nth-child(8) > a")
        .map(
            (_, el) =>
                "https://www.schwab.com/app/branch-services/financial-consultant/" +
                el.attribs["href"].match(/\('(.+)'\)/)?.[1]
        )
        .toArray();
    // console.log(advisorLinks);

    return await BluePromise.map(
        advisorLinks,
        async (advisorLink) => await scrapeSchwabPage(advisorLink),
        { concurrency: 20 }
    );
}

async function scrapeSchwabPage(url: string) {
    const html = await (await fetch(url)).text();
    const $ = cheerio.load(html);

    const name = $("h1").text().trim();
    const phoneNo = $("a.phone-number")
        .first()
        .text()
        .replace("+1", "")
        .replaceAll("-", "")
        .trim();
    const matchGroups = $(
        "div#_Branch_information-body div.schfx-text__body > p:nth-child(2)"
    )
        .html()
        ?.match(
            /<br>(?<address1>.+?)<br>(?<address2>.+?)?<br>(?<city>.+?)<br>(?<state>\w{2}).+?<br>\d{3}-\d{3}-\d{4}/
        )?.groups;
    const address = [matchGroups?.address1, matchGroups?.address2]
        .filter((addressPart): addressPart is string => !!addressPart)
        .join(", ");
    const city = matchGroups?.city;
    const state = matchGroups?.state;
    const sites = [url];

    return <AdvisorInfo>{
        name,
        phoneNo,
        address,
        city,
        state,
        sites,
    };
}

async function scrapeLPL(
    zip: string,
    browser: Browser
): Promise<AdvisorInfo[]> {
    const page = await browser.newPage();
    await page.goto(
        "https://faa.lpl.com/FindAnAdvisor/app/advisor-search.html"
    );
    await page.type("input#address", zip, { delay: 100 });
    await page.click("button.btn");
    await page.waitForSelector("div.info-adv");
    for (
        let showMoreResult = await page.$("a.showMoreResult");
        showMoreResult !== null && (await showMoreResult.isVisible());
        showMoreResult = await page.$("a.showMoreResult")
    ) {
        await showMoreResult.click();
    }
    const html = await page.content();
    const $ = cheerio.load(html);
    await page.close();

    return $("div.info-adv")
        .map((_, advisorRow) => {
            const $advisorRow = $(advisorRow);
            const name = $advisorRow
                .find("p.name")
                .text()
                .trim()
                .replace("  ", " ")
                .replace(
                    /\w\S*/g,
                    (text) =>
                        text.charAt(0).toUpperCase() +
                        text.substring(1).toLocaleLowerCase()
                );
            const address = $advisorRow
                .find("div > p:nth-child(2)")
                .text()
                .trim()
                .split("\n")[0];
            // console.log($advisorRow.find("div > p:nth-child(2)").text());
            const matchCityState = $advisorRow
                .find("div > p:nth-child(2)")
                .text()
                .trim()
                .split("\n")[1]
                .trim()
                .match(/(?<city>.+), (?<state>\w{2}) \d{5}/)?.groups;
            const city = matchCityState?.city;
            const state = matchCityState?.state;
            const phoneNo = $advisorRow
                .find("div > p > a")
                .filter((_, el) => el.attribs["href"].startsWith("tel"))
                .first()
                .text()
                .replaceAll(/\D/g, "");
            const email = $advisorRow.find("a.search-result-email").text();
            return <AdvisorInfo>{
                name,
                address,
                city,
                state,
                phoneNo,
                email,
            };
        })
        .toArray();
}
