'use client';

interface FooterProps {
  contactEmail?: string;
}

export default function Footer({ contactEmail }: FooterProps) {
  // Use the provided email or fall back to the environment variable
  const email = contactEmail || process.env.NEXT_PUBLIC_CONTACT_EMAIL || 'info@wetbulb35.com';
  
  return (
    <footer className="mt-12 py-6 border-t border-gray-200">
      <div className="max-w-4xl mx-auto px-4">
        <div className="flex flex-col md:flex-row justify-between items-center">
          <div className="mb-4 md:mb-0">
            <p className="text-sm text-gray-600">
              © {new Date().getFullYear()} Wetbulb Temperature Monitor
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">
              Contact us at: <span className="font-medium">{email}</span>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
