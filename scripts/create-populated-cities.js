import csv from 'csvtojson';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const inputFile = join(__dirname, 'allCountries.txt');
const outputFile = join(__dirname, 'populated_cities.json');

const headers = [
  'geonameid',
  'name',
  'asciiname',
  'alternatenames',
  'latitude',
  'longitude',
  'featureClass',
  'featureCode',
  'countryCode',
  'cc2',
  'admin1Code',
  'admin2Code',
  'admin3Code',
  'admin4Code',
  'population',
  'elevation',
  'dem',
  'timezone',
  'modificationDate',
];

const MIN_POPULATION = 25000;
const CITY_FEATURE_CODES = new Set([
  'PPL',
  'PPLA',
  'PPLA2',
  'PPLA3',
  'PPLA4',
  'PPLC',
  'PPLF',
  'PPLG',
  'PPLL',
  'PPLQ',
  'PPLR',
  'PPLS',
  'PPLW',
  'PPLX',
]);

const writeStream = createWriteStream(outputFile);
writeStream.write('[\n');

let isFirstItem = true;
let processedCount = 0;
let skippedCount = 0;

csv({
  delimiter: '\t',
  noheader: false,
  headers,
})
  .fromFile(inputFile)
  .subscribe(
    (item) => new Promise((resolve) => {
      const population = Number(item.population);
      const latitude = Number(item.latitude);
      const longitude = Number(item.longitude);

      if (
        item.featureClass === 'P' &&
        CITY_FEATURE_CODES.has(item.featureCode) &&
        Number.isFinite(population) &&
        population > MIN_POPULATION &&
        Number.isFinite(latitude) &&
        Number.isFinite(longitude)
      ) {
        const city = {
          name: item.name,
          latitude,
          longitude,
          countryCode: item.countryCode,
          admin1Code: item.admin1Code,
          population,
        };

        if (!isFirstItem) {
          writeStream.write(',\n');
        }

        writeStream.write(JSON.stringify(city));
        isFirstItem = false;
        processedCount += 1;

        if (processedCount % 5000 === 0) {
          console.log(`Processed ${processedCount.toLocaleString()} populated places...`);
        }
      } else {
        skippedCount += 1;

        if (skippedCount % 100000 === 0) {
          console.log(`Skipped ${skippedCount.toLocaleString()} rows...`);
        }
      }

      resolve();
    }),
    (error) => {
      console.error(error);
      writeStream.end();
      process.exitCode = 1;
    },
    () => {
      writeStream.write('\n]\n');
      writeStream.end();
      console.log(`Wrote ${processedCount.toLocaleString()} populated places to ${outputFile}`);
    },
  );
