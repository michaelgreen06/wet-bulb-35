'use client';

export type HotspotFilterState = {
  sortBy: 'wetBulb' | 'temperature' | 'humidity' | 'hotHours';
  minWetBulb: number;
  minTemperature: number;
  limit: number;
};

type HotspotFiltersProps = {
  filters: HotspotFilterState;
  onChange: (filters: HotspotFilterState) => void;
};

function updateNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default function HotspotFilters({
  filters,
  onChange,
}: HotspotFiltersProps) {
  return (
    <section
      className="rounded-3xl border border-orange-200 bg-white/90 p-5 shadow-xl shadow-orange-100/50 backdrop-blur"
    >
      <div className="grid gap-4 md:grid-cols-4">
        <label className="space-y-2 text-sm font-semibold text-stone-700">
          Sort by
          <select
            value={filters.sortBy}
            onChange={(event) =>
              onChange({ ...filters, sortBy: event.target.value as HotspotFilterState['sortBy'] })
            }
            className="w-full rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 text-stone-900 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-200"
          >
            <option value="wetBulb">Highest wet bulb</option>
            <option value="temperature">Highest air temp</option>
            <option value="humidity">Highest humidity</option>
            <option value="hotHours">Most hot hours</option>
          </select>
        </label>

        <label className="space-y-2 text-sm font-semibold text-stone-700">
          Min wet bulb °C
          <input
            min={0}
            max={40}
            step={0.5}
            type="number"
            value={filters.minWetBulb}
            onChange={(event) =>
              onChange({ ...filters, minWetBulb: updateNumber(event.target.value, 0) })
            }
            className="w-full rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 text-stone-900 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-200"
          />
        </label>

        <label className="space-y-2 text-sm font-semibold text-stone-700">
          Min air temp °C
          <input
            min={0}
            max={55}
            step={0.5}
            type="number"
            value={filters.minTemperature}
            onChange={(event) =>
              onChange({ ...filters, minTemperature: updateNumber(event.target.value, 0) })
            }
            className="w-full rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 text-stone-900 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-200"
          />
        </label>

        <label className="space-y-2 text-sm font-semibold text-stone-700">
          Limit
          <input
            min={1}
            max={200}
            type="number"
            value={filters.limit}
            onChange={(event) =>
              onChange({ ...filters, limit: updateNumber(event.target.value, 50) })
            }
            className="w-full rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2 text-stone-900 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-200"
          />
        </label>
      </div>

      <div className="mt-5">
        <p className="text-sm text-stone-600">
          These controls sort and filter the latest generated snapshot only. They do not request a new forecast scan.
        </p>
      </div>
    </section>
  );
}
