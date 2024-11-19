import puppeteer from 'puppeteer';
import fs from 'fs/promises';

function delay(time) {
  return new Promise(function(resolve) { 
      setTimeout(resolve, time)
  });
}

async function initBrowser() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.setViewport({width: 1080, height: 1024});
  return { browser, page };
}

async function searchGoogleMaps(page, searchQuery) {
  await page.goto('https://google.com/maps');
  await page.locator('#searchboxinput').fill(searchQuery);
  await page.locator('#searchbox-searchbutton').click();
  await page.waitForSelector(`[aria-label="Results for ${searchQuery}"]`);
  await delay(2000);
}

class RestaurantScraper {
  constructor(browser, page) {
    this.browser = browser;
    this.page = page;
  }

  async scrollToEnd() {
    try {
      await this.page.waitForSelector('div[role="feed"]');
      await delay(3000);

      console.log("Scrolling to load all restaurants...");
      let lastHeight = await this.page.evaluate(() => 
        document.querySelector('div[role="feed"]').scrollHeight
      );
      let scrollAttempts = 0;
      const maxAttempts = 50;

      while (scrollAttempts < maxAttempts) {
        await this.page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          feed.scrollTo(0, feed.scrollHeight * 2);
        });
        await delay(2000);

        // Check for end of list
        const endOfList = await this.page.evaluate(() => {
          const endText = document.evaluate(
            "//*[contains(text(), 'reached the end of the list')]",
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          return endText && endText.offsetParent !== null;
        });

        if (endOfList) {
          console.log("Reached the end of the list");
          return;
        }

        const newHeight = await this.page.evaluate(() =>
          document.querySelector('div[role="feed"]').scrollHeight
        );

        if (newHeight === lastHeight) {
          await delay(2000);
          const finalCheck = await this.page.evaluate(() =>
            document.querySelector('div[role="feed"]').scrollHeight
          );
          if (finalCheck === lastHeight) {
            console.log("No more results to load");
            return;
          }
        }

        lastHeight = newHeight;
        scrollAttempts++;

        if (scrollAttempts % 5 === 0) {
          console.log(`Scrolled ${scrollAttempts} times...`);
        }
      }
      console.log("Reached maximum scroll attempts");
    } catch (error) {
      console.error("Error during scrolling:", error);
    }
  }

  async extractRestaurantInfo() {
    try {
      await this.page.waitForSelector('div[role="main"]');
      
      const restaurantInfo = await this.page.evaluate(() => {
        const mainDivs = document.querySelectorAll('div[role="main"]');
        const mainDiv = mainDivs[1];
        if (!mainDiv) return null;

        const name = mainDiv.querySelector('h1, h2')?.textContent || 'N/A';
        
        const addressButton = mainDiv.querySelector('button[data-item-id^="address"]');
        const address = addressButton ? addressButton.textContent.replace(/[^\w\s,.-]/g, '').replace(/\s+/g, ' ').trim() : 'N/A';
        
        const phoneButton = mainDiv.querySelector('button[data-item-id^="phone"]');
        let phone = phoneButton ? phoneButton.textContent : 'N/A';
        const phoneMatch = phone.match(/(?:\+\d{1,3}[\s.-]?)?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,4}/);
        phone = phoneMatch ? phoneMatch[0].replace(/[^\d+]/g, ' ').replace(/\s+/g, ' ').trim() : phone;
        
        const websiteButton = mainDiv.querySelector('a[data-item-id^="authority"]');
        let website = websiteButton ? websiteButton.textContent : 'N/A';
        const websiteMatch = website.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+(?:\.[a-zA-Z]{2,})+)/);
        website = websiteMatch ? websiteMatch[1] : website;

        return { name, phone, website, address };
      });

      console.log("Extracted:", restaurantInfo);
      return restaurantInfo;
    } catch (error) {
      console.error("Error extracting restaurant info:", error);
      return null;
    }
  }

  async scrapeRestaurants() {
    const restaurantsData = [];
    
    try {
      await this.scrollToEnd();
      
      const restaurantLinks = await this.page.$$('div[role="feed"] > div > div > a');
      console.log(`Found ${restaurantLinks.length} restaurants`);

      for (let i = 0; i < restaurantLinks.length; i++) {
        console.log(`Processing item #${i + 1} out of ${restaurantLinks.length}`);
        
        try {
          await this.page.evaluate((link) => {
            link.scrollIntoView();
          }, restaurantLinks[i]);
          await delay(500);

          await restaurantLinks[i].click();
          await delay(2000);

          const restaurantInfo = await this.extractRestaurantInfo();
          if (restaurantInfo) {
            restaurantsData.push(restaurantInfo);
            console.log(`Scraped: ${restaurantInfo.name}`);
          }
        } catch (error) {
          console.error("Error processing restaurant:", error);
          continue;
        }
      }
    } catch (error) {
      console.error("Error scraping restaurants:", error);
    }

    return restaurantsData;
  }

  async saveToCSV(data, filename = 'restaurants.csv') {
    const csvContent = [
      Object.keys(data[0]).join(','),
      ...data.map(item => Object.values(item).join(','))
    ].join('\n');

    await fs.writeFile(filename, csvContent);
    console.log(`Data saved to ${filename}`);
  }
}

async function main() {
  const { browser, page } = await initBrowser();
  
  try {
    await searchGoogleMaps(page, 'restaurant near Keiraville, New South Wales, Australia');
    
    const scraper = new RestaurantScraper(browser, page);
    const restaurantsData = await scraper.scrapeRestaurants();
    await scraper.saveToCSV(restaurantsData);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);