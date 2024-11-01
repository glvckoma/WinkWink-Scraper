const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const levenshtein = require('fast-levenshtein');

puppeteer.use(StealthPlugin());

const app = express();
const port = 3000;

function tokenizeAndNormalize(text) {
  return text.toLowerCase().replace(/[^\w\s]|_/g, "").replace(/\s+/g, " ").split(" ");
}

function calculateMatchScore(queryTokens, text) {
  const textTokens = tokenizeAndNormalize(text);
  const keywordOverlap = queryTokens.filter(token => textTokens.includes(token)).length;
  const levenshteinScore = levenshtein.get(queryTokens.join(" "), textTokens.join(" "));
  
  const overlapWeight = keywordOverlap * 10;
  const levenshteinWeight = -levenshteinScore;

  return overlapWeight + levenshteinWeight;
}

app.get('/scrape', async (req, res) => {
  const query = req.query.query;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter is missing' });
  }

  console.log(`Starting scrape for Google search query: site:quizlet.com ${query}`);

  const queryTokens = tokenizeAndNormalize(query);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,  // Non-headless mode
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--window-size=1,1',  // Window size of 1x1 pixels
        '--window-position=0,1079',  // Bottom-left position for a 1920x1080 screen
      ],
    });
    
    

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    const searchUrl = `https://www.google.com/search?q=site:quizlet.com+${encodeURIComponent(query)}`;
    console.log(`Google search URL: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Extract only valid Quizlet URLs
    const quizletLinks = await page.$$eval('a', anchors =>
      anchors
        .map(anchor => anchor.href)
        .filter(href => href.includes('quizlet.com') && !href.includes('google.com')) // Ensure we're only grabbing direct Quizlet links
        .slice(0, 6) // Limit to the first 6 URLs
    );

    if (quizletLinks.length === 0) {
      throw new Error('No Quizlet links found in the Google search results.');
    }

    console.log(`Found Quizlet links: ${quizletLinks}`);

    let results = [];

    for (const link of quizletLinks) {
      console.log(`Visiting Quizlet URL: ${link}`);
      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const termsPresent = await page.$('div[aria-label="Term"].SetPageTerms-term');
        if (!termsPresent) {
          console.log(`No terms found on Quizlet page: ${link}`);
          continue;
        }

        const terms = await page.$$eval('div[aria-label="Term"].SetPageTerms-term', elements => {
          return elements.map(el => {
            const question = el.querySelector('div[data-testid="set-page-card-side"]:first-child span.TermText')?.innerText || "No question found";
            const answer = el.querySelector('div[data-testid="set-page-card-side"]:last-child span.TermText')?.innerText || "No answer found";
            return { word: question, definition: answer };
          });
        });

        const scoredTerms = terms.map(term => {
          const combinedText = `${term.word} ${term.definition}`;
          const score = calculateMatchScore(queryTokens, combinedText);
          return { ...term, matchScore: score, source: 'Google Scraping' }; // Add the source property here
        });

        const bestMatches = scoredTerms.sort((a, b) => b.matchScore - a.matchScore).slice(0, 5);

        results = [...results, ...bestMatches];
      } catch (error) {
        console.error(`Error visiting Quizlet URL: ${link} - ${error.message}`);
      }
    }

    results.sort((a, b) => b.matchScore - a.matchScore);
    await browser.close();
    res.json(results);
  } catch (error) {
    console.error("Error during scraping:", error);

    if (browser) {
      await browser.close();
    }

    res.status(500).json({ error: 'Scraping failed' });
  }
});

app.listen(port, () => {
  console.log(`Scraper server running at http://localhost:${port}`);
});
