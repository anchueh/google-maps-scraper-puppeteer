import puppeteer from 'puppeteer';
import fs from 'fs/promises';

async function initBrowser() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({width: 1080, height: 1024});
  return { browser, page };
}

async function searchGoogleMaps(page, searchQuery) {
  await page.goto('https://google.com/maps');
  await page.locator('#searchboxinput').fill(searchQuery);
  await page.locator('#searchbox-searchbutton').click();
  await page.waitForSelector(`[aria-label="Results for ${searchQuery}"]`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class RestaurantScraper {
  constructor(browser, page) {
    this.browser = browser;
    this.page = page;
  }

  async scrollToEnd() {
    try {
      await this.page.waitForSelector('div[role="feed"]');
      await this.page.waitForFunction(() => {
        const feed = document.querySelector('div[role="feed"]');
        return feed && feed.children.length > 0;
      });

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
        
        await this.page.waitForFunction(
          (prevHeight) => {
            const feed = document.querySelector('div[role="feed"]');
            return feed.scrollHeight > prevHeight;
          },
          {},
          lastHeight
        );

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
          await this.page.waitForFunction(() => {
            const loadingIndicator = document.querySelector('.loading-indicator');
            return !loadingIndicator || loadingIndicator.style.display === 'none';
          }, { timeout: 2000 }).catch(() => {});

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
          
          await this.page.waitForFunction(
            (link) => {
              const rect = link.getBoundingClientRect();
              return rect.top >= 0 && rect.bottom <= window.innerHeight;
            },
            {},
            restaurantLinks[i]
          );

          // Add retry mechanism for clicking and waiting
          let retryCount = 0;
          const maxRetries = 3;
          let success = false;

          while (!success && retryCount < maxRetries) {
            try {
              await restaurantLinks[i].click();
              
              // Wait for both conditions with a reasonable timeout
              await this.page.waitForFunction(
                () => {
                  const mainDivs = document.querySelectorAll('div[role="main"]');
                  return mainDivs.length >= 2;
                },
                { timeout: 2000 * (retryCount + 1) }
              );
              
              success = true;
            } catch (error) {
              retryCount++;
              console.log(`Retry ${retryCount}/${maxRetries} for restaurant ${i + 1}`);
              // Wait a bit before retrying
              await delay(1000);
            }
          }

          if (!success) {
            console.error(`Failed to open details for restaurant ${i + 1} after ${maxRetries} attempts`);
            continue;
          }

          const restaurantInfo = await this.extractRestaurantInfo();
          if (restaurantInfo) {
            restaurantsData.push(restaurantInfo);
            console.log(`Scraped: ${restaurantInfo.name}`);
          }

          // Get specifically the second div[role="main"] and its Close button
          await this.page.evaluate(() => {
            const mainDivs = document.querySelectorAll('div[role="main"]');
            const closeButton = mainDivs[1].querySelector('button[aria-label="Close"]');
            if (closeButton) closeButton.click();
          });
          
          // Wait for the panel to be fully closed
          await this.page.waitForFunction(() => {
            const mainDivs = document.querySelectorAll('div[role="main"]');
            return mainDivs.length === 1;
          });

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
  const startTime = Date.now();
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
    const endTime = Date.now();
    console.log(`Scraping completed in ${Math.floor((endTime - startTime) / 1000)} seconds`);
  }
}

main().catch(console.error);