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

function decamelize(str) {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function decamelizeKeys(obj) {
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [decamelize(key), value]));
}

const extractDetailedInfo = () => {
  const mainDivs = document.querySelectorAll('div[role="main"]');
  const mainDiv = mainDivs[1];
  if (!mainDiv) return null;

  // business_types: transform_string_array(place[:types], required: true),
  // business_status: transform_string(place[:business_status]),
  // operating_hours: transform_hash(place[:current_opening_hours]),
  // primary_business_type: transform_string(place[:primary_type]),
  // image_urls: transform_string_array(extract_photo_urls(place[:photos])),
  // reviews: transform_hash_array(place[:reviews]),

  const name = mainDiv.querySelector('h1, h2')?.textContent || 'N/A';
  const fullAddress = mainDiv.querySelector('button[data-item-id^="address"] > div > div:nth-child(2) > div')?.textContent || 'N/A';
  const phoneNumber = mainDiv.querySelector('button[data-item-id^="phone"] > div > div:nth-child(2) > div')?.textContent?.replace(/\s+/g, '') || 'N/A';
  const websiteUrl = mainDiv.querySelector('a[data-item-id^="authority"]')?.href || 'N/A';

  const addressParts = fullAddress.split(',').map(part => part.trim());
        
  let suburb = 'N/A';
  let state = 'N/A';
  let postcode = 'N/A';
  let country = 'N/A';

  if (addressParts.length > 0) {
    country = addressParts[addressParts.length - 1] || 'N/A';

    const statePostcodePart = addressParts[addressParts.length - 2] || '';
    const statePostcodeMatch = statePostcodePart.match(/(?:(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+(\d{4}))/i);
    if (statePostcodeMatch) {
      state = statePostcodeMatch[1].toUpperCase();
      postcode = statePostcodeMatch[2];
    }

    if (addressParts.length > 2) {
      suburb = addressParts[addressParts.length - 3].replace(/^\d+\s+/, '').trim();
    }
  }

  return { 
    name, 
    phoneNumber, 
    websiteUrl, 
    fullAddress,
    suburb,
    state,
    postcode,
    country
  };
}

const extractBriefInfo = (item) => {
  const href = item.href;
  const placeId = (href || '').match(/!19s(.*?)\?|!19s(.*?)$/)?.[1] || 'N/A';
  const latMatch = href.match(/!3d(-?\d+\.\d+)/);
  const lngMatch = href.match(/!4d(-?\d+\.\d+)/);
      
  const latitude = latMatch ? parseFloat(latMatch[1]) : null;
  const longitude = lngMatch ? parseFloat(lngMatch[1]) : null;

  const parent = item.parentElement;

  const ratingText = parent.querySelector('span.fontBodyMedium > span')?.getAttribute('aria-label') || 'N/A';
  const bodyDiv = parent.querySelector('div.fontBodyMedium');
  const firstRow = bodyDiv?.children[0]?.textContent || '';
  const category = firstRow.split('·')[0]?.trim() || 'N/A';

  const googleRating = ratingText !== 'N/A' ? parseFloat(ratingText.split('stars')[0]?.trim()) : null;
  const userRatingCount = ratingText !== 'N/A' 
    ? parseInt(ratingText.split('stars')[1]?.replace('Reviews', '')?.trim()) 
    : null;

  return { 
    placeId, 
    latitude, 
    longitude,
    category,
    googleRating,
    userRatingCount
  };
}

const executeWithRetry = async ({ func, retries = 3, actionName }) => {
  const maxRetries = retries;
  let retryCount = 0;
  let success = false;

  while (!success && retryCount < maxRetries) {
    try {
      await func(retryCount);
      success = true;
    } catch (error) {
      console.log(`${actionName} failed, retrying... (${retryCount}/${maxRetries})`);
      retryCount++;
      await delay(1000);
    }
  }

  return success;
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

  async scrapeRestaurants() {
    const restaurantsData = [];
    
    try {
      await this.scrollToEnd();
      
      const restaurantLinks = await this.page.$$('div[role="feed"] > div > div > a');
      console.log(`Found ${restaurantLinks.length} restaurants`);

      for (let i = 0; i < restaurantLinks.length; i++) {
        console.log(`Processing item #${i + 1} out of ${restaurantLinks.length}`);

        const briefInfo = await restaurantLinks[i].evaluate(extractBriefInfo);
        
        try {
          const scrollingSuccess = await executeWithRetry({
            func: async (retryCount) => {
              await this.page.evaluate((link) => {
                link.scrollIntoView();
              }, restaurantLinks[i]);
              
              await this.page.waitForFunction(
                (link) => {
                  const rect = link.getBoundingClientRect();
                  return rect.top >= 0 && rect.bottom <= window.innerHeight;
                },
                { timeout: 2000 * (retryCount + 1) },
                restaurantLinks[i]
              );
            },
            actionName: `Scrolling to restaurant ${i + 1}`
          });

          if (!scrollingSuccess) {
            console.error(`Failed to scroll to restaurant ${i + 1} after ${scrollingMaxRetries} attempts`);
            continue;
          }

          const restaurantClickingSuccess = await executeWithRetry({
            func: async (retryCount) => {
              await restaurantLinks[i].click();
              
              await this.page.waitForFunction(
                () => {
                  const mainDivs = document.querySelectorAll('div[role="main"]');
                  return mainDivs.length >= 2;
                },
                { timeout: 2000 * (retryCount + 1) }
              );
            },
            actionName: `Clicking restaurant ${i + 1}`
          });

          if (!restaurantClickingSuccess) {
            console.error(`Failed to open details for restaurant ${i + 1} after ${restaurantClickingMaxRetries} attempts`);
            continue;
          }

          const detailedInfo = await this.page.evaluate(extractDetailedInfo);
          const newItem = decamelizeKeys({
            ...detailedInfo,
            ...briefInfo
          });
          if (detailedInfo) {
            restaurantsData.push(newItem);
            console.log(`Scraped: ${detailedInfo.name} (${briefInfo.placeId})`);
            console.log(newItem);
          }

          const closingSuccess = await executeWithRetry({
            func: async (retryCount) => {
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
              }, { timeout: 2000 * (retryCount + 1) });

            },
            actionName: `Closing restaurant ${i + 1}`
          });

          if (!closingSuccess) {
            console.error(`Failed to close restaurant ${i + 1} after ${closingMaxRetries} attempts`);
            continue;
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

  async saveToCSV(data, filename) {
    if (!data || data.length === 0) {
      console.log('No data to save');
      return;
    }
    
    const csvContent = [
      Object.keys(data[0]).join(','),
      ...data.map(item => Object.values(item).join(','))
    ].join('\n');

    await fs.writeFile(filename, csvContent);
    console.log(`Data saved to ${filename}`);
  }
}

export async function scrapeQuery(searchQuery, outputFile) {
  const startTime = Date.now();
  const { browser, page } = await initBrowser();
  
  try {
    await searchGoogleMaps(page, searchQuery);
    
    const scraper = new RestaurantScraper(browser, page);
    const restaurantsData = await scraper.scrapeRestaurants();
    await scraper.saveToCSV(restaurantsData, outputFile);
    return restaurantsData;
  } catch (error) {
    console.error('Error:', error);
    return [];
  } finally {
    await browser.close();
    const endTime = Date.now();
    console.log(`Scraping completed in ${Math.floor((endTime - startTime) / 1000)} seconds`);
  }
}