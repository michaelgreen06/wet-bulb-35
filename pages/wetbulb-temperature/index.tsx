import { GetStaticProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import fs from 'fs';
import path from 'path';
import { toSlug } from '../../lib/utils/string';
import Header from '../../components/Header';
import Footer from '../../components/Footer';
import { useRouter } from 'next/router';

interface CountryData {
  name: string;
  count: number;
}

interface CountriesPageProps {
  countries: CountryData[];
}

export default function CountriesPage({ countries }: CountriesPageProps) {
  const router = useRouter();
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.wetbulb35.com';
  
  const pageTitle = 'Wet Bulb Temperature by Country';
  const pageDescription = 'Browse wet bulb temperature data by country. Select a country to view state/province data.';
  const canonicalUrl = `${baseUrl}/wetbulb-temperature`;
  const imageUrl = `${baseUrl}/images/wetbulb-default.jpg`;

  // Breadcrumb structured data
  const breadcrumbData = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {
        "@type": "ListItem",
        "position": 1,
        "name": "Wet Bulb Temperature",
        "item": `${baseUrl}/wetbulb-temperature`
      }
    ]
  };



  return (
    <>
      <Head>
        <title>{pageTitle}</title>
        <meta name="description" content={pageDescription} />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="robots" content="index, follow" />
        <link rel="canonical" href={canonicalUrl} />
        
        {/* Open Graph tags */}
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={pageDescription} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={canonicalUrl} />
        <meta property="og:image" content={imageUrl} />
        <meta property="og:locale" content="en_US" />
        <meta property="og:site_name" content="Wet Bulb Temperature" />
        
        {/* Twitter Card tags */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={pageTitle} />
        <meta name="twitter:description" content={pageDescription} />
        <meta name="twitter:image" content={imageUrl} />
        
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(breadcrumbData)
          }}
        />
      </Head>

      <div className="max-w-4xl mx-auto space-y-8">
        <Header />
        
        <div className="space-y-6">
          <div className="mt-6">
            <h1 className="text-3xl font-bold mb-6">Browse Wet Bulb Temperature by Country</h1>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {countries.map((country) => (
                <Link 
                  key={country.name} 
                  href={`/wetbulb-temperature/${toSlug(country.name)}`}
                  className="p-4 border rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div className="font-semibold">{country.name}</div>
                  <div className="text-sm text-gray-500">{country.count} locations</div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
      
      <Footer />
    </>
  );
}

export const getStaticProps: GetStaticProps = async () => {
  try {
    // Read and parse the cities data
    const citiesPath = path.join(process.cwd(), 'scripts', 'resolved_cities.json');
    
    if (!fs.existsSync(citiesPath)) {
      console.error('Cities data file not found:', citiesPath);
      return { notFound: true };
    }

    const citiesData = JSON.parse(fs.readFileSync(citiesPath, 'utf-8'));
    
    // Group cities by country and count them
    const countryMap = new Map<string, number>();
    
    citiesData.forEach((city: { resolvedCountryName?: string }) => {
      const countryName = city.resolvedCountryName;
      if (countryName) {
        countryMap.set(countryName, (countryMap.get(countryName) || 0) + 1);
      }
    });
    
    // Convert to array and sort alphabetically
    const countries = Array.from(countryMap.entries()).map(([name, count]) => ({
      name,
      count
    })).sort((a, b) => a.name.localeCompare(b.name));

    return {
      props: {
        countries
      },
      revalidate: 86400 // Revalidate once per day
    };
  } catch (error) {
    console.error('Error in getStaticProps:', error);
    return { notFound: true };
  }
};
