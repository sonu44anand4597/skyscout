import argparse
import io
import csv
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
from unittest.mock import patch

from download_bts import combine_archives, download_archive, download_with_retries, months_between, parse_month
from train import REQUIRED


class DownloadBtsTests(unittest.TestCase):
    def test_parse_month_requires_year_and_month(self):
        self.assertEqual(parse_month("2023-09"), (2023, 9))
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_month("2023-13")
        with self.assertRaises(argparse.ArgumentTypeError):
            parse_month("2023/09")

    def test_month_range_includes_end_and_rejects_reversed_range(self):
        self.assertEqual(months_between((2023, 11), (2024, 2)), [(2023, 11), (2023, 12), (2024, 1), (2024, 2)])
        with self.assertRaises(ValueError):
            months_between((2024, 2), (2024, 1))

    def test_combine_archives_keeps_one_header_and_records_manifest_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archives = []
            for month, flight_date in [(1, "2023-01-01"), (2, "2023-02-01")]:
                archive_path = root / f"BTS_2023_{month:02d}.zip"
                row = {
                    "FlightDate": flight_date,
                    "Reporting_Airline": "XX",
                    "Origin": "AAA",
                    "Dest": "BBB",
                    "CRSDepTime": "900",
                    "CRSElapsedTime": "120",
                    "Distance": "500",
                    "ArrDelay": "5",
                    "Cancelled": "0",
                    "IgnoredExtra": "not copied",
                }
                with ZipFile(archive_path, "w") as archive:
                    with tempfile.TemporaryFile(mode="w+") as csv_file:
                        writer = csv.DictWriter(csv_file, fieldnames=row)
                        writer.writeheader()
                        writer.writerow(row)
                        csv_file.seek(0)
                        archive.writestr(f"month-{month}.csv", csv_file.read())
                    archive.writestr("readme.html", "BTS")
                archives.append(archive_path)

            output = root / "combined.csv"
            manifest = combine_archives(archives, output, chunk_size=1)
            lines = output.read_text(encoding="utf-8").splitlines()
            self.assertEqual(manifest["records"], 2)
            self.assertEqual(manifest["months"], ["2023_01", "2023_02"])
            self.assertEqual(len(lines), 3)
            self.assertEqual(lines[0].split(","), REQUIRED)
            self.assertNotIn("IgnoredExtra", lines[0])
            self.assertEqual(len(manifest["sha256"]), 64)

    def test_download_resumes_a_cached_partial_with_http_range(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "BTS_2023_03.zip"
            partial_path = destination.with_suffix(".zip.part")
            payload = io.BytesIO()
            with ZipFile(payload, "w") as archive:
                archive.writestr("flights.csv", ",".join(REQUIRED) + "\n")
            archive_bytes = payload.getvalue()
            offset = 19
            partial_path.write_bytes(archive_bytes[:offset])

            class Response:
                status = 206

                def __init__(self, data):
                    self.stream = io.BytesIO(data)
                    self.headers = {"Content-Range": f"bytes {offset}-{len(archive_bytes) - 1}/{len(archive_bytes)}"}

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    self.stream.close()

                def read(self, size):
                    return self.stream.read(size)

            def urlopen(request, timeout):
                self.assertEqual(request.get_header("Range"), f"bytes={offset}-")
                self.assertEqual(timeout, 3)
                return Response(archive_bytes[offset:])

            with patch("download_bts.urllib.request.urlopen", side_effect=urlopen):
                download_archive(2023, 3, destination, timeout=3)

            self.assertEqual(destination.read_bytes(), archive_bytes)
            self.assertFalse(partial_path.exists())

    def test_timed_out_downloads_retry_with_bounded_backoff(self):
        calls = []
        delays = []

        def download(_year, _month, _destination, _timeout):
            calls.append(True)
            if len(calls) < 3:
                raise TimeoutError("paused")

        with patch("download_bts.download_archive", side_effect=download):
            download_with_retries(2024, 1, Path("unused.zip"), 10, retries=3, sleep=delays.append)
        self.assertEqual(len(calls), 3)
        self.assertEqual(delays, [1, 2])


if __name__ == "__main__":
    unittest.main()
