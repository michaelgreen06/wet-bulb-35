import { GetStaticProps, GetStaticPaths } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import fs from 'fs';
import path from 'path';
import { toSlug } from '../../../lib/utils/string';
import Header from '../../../components/Header';
import Footer from '../../../components/Footer';
import { useRouter } from 'next/router';

interface StateData {
  name: string;
  count: number;
}

interface CountryPageProps {
  countryName: string;
  states: StateData[];
}

export default function CountryPage({ countryName, states }: CountryPageProps) {
  const router = useRouter();
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.wetbulb35.com';
  
  // Show loading state while page is being generated
  if (router.isFallback) {
    return <div>Loading...</div>;
  }
  
  const countrySlug = toSlug(countryName);
  const pageTitle = `Wet Bulb Temperature in ${countryName}`;
  const pageDescription = `Browse wet bulb temperature data for states and provinces in ${countryName}. Select a state to view city data.`;
  const canonicalUrl = `${baseUrl}/wetbulb-temperature/${countrySlug}`;
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
      },
      {
        "@type": "ListItem",
        "position": 2,
        "name": countryName,
        "item": `${baseUrl}/wetbulb-temperature/${countrySlug}`
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
            <div className="mb-6">
              <Link href="/wetbulb-temperature" className="text-blue-600 hover:underline">
                ← Back to Countries
              </Link>
            </div>
            
            <h1 className="text-3xl font-bold mb-6">Browse {countryName} by State/Province</h1>
            
            {states.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {states.map((state) => (
                  <Link 
                    key={state.name} 
                    href={`/wetbulb-temperature/${countrySlug}/${toSlug(state.name)}`}
                    className="p-4 border rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <div className="font-semibold">{state.name}</div>
                    <div className="text-sm text-gray-500">{state.count} locations</div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="p-4 border rounded-lg bg-gray-50">
                <p>No states or provinces found for this country.</p>
              </div>
            )}
          </div>
        </div>
      </div>
      
      <Footer />
    </>
  );
}

export const getStaticPaths: GetStaticPaths = async () => {
  try {
    // Read and parse the cities data
    const citiesPath = path.join(process.cwd(), 'scripts', 'resolved_cities.json');
    
    if (!fs.existsSync(citiesPath)) {
      console.error('Cities data file not found:', citiesPath);
      return { paths: [], fallback: false };
    }

    const citiesData = JSON.parse(fs.readFileSync(citiesPath, 'utf-8'));
    
    // Get unique countries
    const countries = new Set<string>();
    
    citiesData.forEach((city: any) => {
      if (city.resolvedCountryName) {
        countries.add(city.resolvedCountryName);
      }
    });
    
    // Generate paths for each country
    const paths = Array.from(countries).map(country => ({
      params: { country: toSlug(country) }
    }));

    return {
      paths,
      fallback: true // Enable ISR for countries not generated at build time
    };
  } catch (error) {
    console.error('Error in getStaticPaths:', error);
    return { paths: [], fallback: false };
  }
};

export const getStaticProps: GetStaticProps = async ({ params }) => {
  try {
    if (!params?.country) {
      return { notFound: true };
    }

    const countrySlug = params.country as string;
    
    // Read and parse the cities data
    const citiesPath = path.join(process.cwd(), 'scripts', 'resolved_cities.json');
    
    if (!fs.existsSync(citiesPath)) {
      console.error('Cities data file not found:', citiesPath);
      return { notFound: true };
    }

    const citiesData = JSON.parse(fs.readFileSync(citiesPath, 'utf-8'));
    
    // Find the country by slug
    let countryName = '';
    const countryData = citiesData.find((city: any) => {
      const match = toSlug(city.resolvedCountryName) === countrySlug;
      if (match) {
        countryName = city.resolvedCountryName;
      }
      return match;
    });
    
    if (!countryName) {
      console.log('No matching country found for slug:', countrySlug);
      return { notFound: true };
    }
    
    // Group cities by state within this country and count them
    const stateMap = new Map<string, number>();
    
    citiesData.forEach((city: any) => {
      if (city.resolvedCountryName === countryName && city.resolvedAdmin1Code) {
        stateMap.set(city.resolvedAdmin1Code, (stateMap.get(city.resolvedAdmin1Code) || 0) + 1);
      }
    });
    
    // Convert to array and sort alphabetically
    const states = Array.from(stateMap.entries()).map(([name, count]) => ({
      name,
      count
    })).sort((a, b) => a.name.localeCompare(b.name));

    return {
      props: {
        countryName,
        states
      },
      revalidate: 86400 // Revalidate once per day
    };
  } catch (error) {
    console.error('Error in getStaticProps:', error);
    return { notFound: true };
  }
};
