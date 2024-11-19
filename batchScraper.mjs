import { scrapeQuery } from './scraper.mjs';
import fs from 'fs/promises';
import path from 'path';
import pidusage from 'pidusage';

const queriesData = JSON.parse(await fs.readFile('./queries.json', 'utf-8'));

const TMP_DIR = `./tmp/${Date.now()}`;
const FINAL_OUTPUT = 'all_restaurants.csv';

async function ensureTmpDir() {
    try {
        await fs.mkdir(TMP_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}

function getUniqueRestaurants(allRestaurants) {
    const seen = new Set();
    return allRestaurants.filter(restaurant => {
        const key = `${restaurant.name}-${restaurant.address}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function readCsvFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    const [headers, ...rows] = content.trim().split('\n');
    const headerArray = headers.split(',');
    
    return rows.map(row => {
        const values = row.split(',');
        return headerArray.reduce((obj, header, index) => {
            obj[header] = values[index];
            return obj;
        }, {});
    });
}

async function trackPerformance() {
    try {
        const stats = await pidusage(process.pid);
        console.log(`CPU Usage: ${stats.cpu.toFixed(2)}%`);
        console.log(`Memory Usage: ${(stats.memory / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
        console.error('Error tracking performance:', err);
    }
}

async function scrapeWithConcurrency(queries, concurrentLimit = 15) {
    const performanceInterval = setInterval(trackPerformance, 5000);
    
    try {
        const chunks = [];
        const results = [];
        
        for (let i = 0; i < queries.length; i += concurrentLimit) {
            chunks.push(queries.slice(i, i + concurrentLimit));
        }
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            console.log(`Processing chunk ${i + 1}/${chunks.length}`);
            
            const chunkPromises = chunk.map(async (queryObj, index) => {
                const query = `restaurant near ${queryObj.name}, New South Wales, Australia`;
                const tmpFile = path.join(TMP_DIR, `restaurants_${i * concurrentLimit + index}.csv`);
                console.log(`Starting query: ${query}`);
                await scrapeQuery(query, tmpFile);
                return tmpFile;
            });

            const chunkResults = await Promise.all(chunkPromises);
            results.push(...chunkResults);
            
            if (i < chunks.length - 1) {
                console.log('Waiting between chunks...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        
        return results;
    } finally {
        clearInterval(performanceInterval);
    }
}

async function main() {
    const startTime = Date.now();
    
    try {
        await ensureTmpDir();
        
        await scrapeWithConcurrency(queriesData.queries);

        const tmpFiles = await fs.readdir(TMP_DIR);
        let allRestaurants = [];

        for (const file of tmpFiles) {
            if (!file.endsWith('.csv')) continue;
            const filePath = path.join(TMP_DIR, file);
            const restaurants = await readCsvFile(filePath);
            allRestaurants = [...allRestaurants, ...restaurants];
        }

        const uniqueRestaurants = getUniqueRestaurants(allRestaurants);
        console.log(`Found ${uniqueRestaurants.length} unique restaurants out of ${allRestaurants.length} total`);

        const csvContent = [
            Object.keys(uniqueRestaurants[0]).join(','),
            ...uniqueRestaurants.map(item => Object.values(item).join(','))
        ].join('\n');

        await fs.writeFile(FINAL_OUTPUT, csvContent);
        console.log(`Final results saved to ${FINAL_OUTPUT}`);

        await fs.rm(TMP_DIR, { recursive: true });
    } finally {
        const executionTime = (Date.now() - startTime) / 1000;
        console.log(`Total execution time: ${executionTime.toFixed(2)} seconds`);
    }
}

main().catch(console.error); 