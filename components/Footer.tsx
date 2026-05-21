'use client';

import { CONTACT_EMAIL } from '../lib/consts';

export default function Footer() {
  return (
    <footer className="mt-12 py-6 border-t border-gray-200">
      <div className="max-w-4xl mx-auto px-4">
        <div className="flex flex-col md:flex-row justify-between items-center">
          <div className="mb-4 md:mb-0">
            <p className="text-sm text-gray-600">
              © {new Date().getFullYear()} Wet Bulb Temperature Monitor
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">
              Contact us at: <span className="font-medium">{CONTACT_EMAIL}</span>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
