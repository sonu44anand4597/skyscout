# Airport location and timezone data

`backend/data/airport-locations.json` is derived from the existing local
`ml/data/airportsdata-airports.csv` snapshot. The derived file records its input
SHA-256, source and derivation time. It is a static catalog, not a live airport
information service. Source: https://github.com/mborsetti/airportsdata

`airport-search.json` derives airport names, cities, countries, timezones and IATA
codes from the same MIT snapshot, with its own source hash and derivation time.
`scripts/build-airport-search-catalog.py` rebuilds it without network access.
Small name/alias supplements are in `airport-search-overrides.json`, including
official Mumbai and Bengaluru naming sources. These supplements do not replace
the worldwide catalog and do not establish flight availability.

The MIT License (MIT)

Copyright (c) 2020- Mike Borsetti <mike@borsetti.com>

This project includes data from https://github.com/mwgg/Airports Copyright
(c) 2014 mwgg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
