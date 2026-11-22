"""Unit checks for calibration and evaluation math; these do not train or ship a model."""
import unittest

import numpy as np
import pandas as pd

from train import FEATURES, choose_f1_threshold, evaluation_metrics, fit_platt_scaling, training_feature_stats


class CalibrationTests(unittest.TestCase):
    def test_platt_scaling_returns_finite_monotonic_parameters(self):
        logits = np.asarray([-2.0, -1.0, -0.5, 0.5, 1.0, 2.0])
        labels = np.asarray([0, 0, 0, 0, 1, 1])
        slope, intercept = fit_platt_scaling(logits, labels)
        probabilities = 1 / (1 + np.exp(-np.clip(slope * logits + intercept, -40, 40)))

        self.assertTrue(np.isfinite(slope))
        self.assertTrue(np.isfinite(intercept))
        self.assertGreater(slope, 0)
        self.assertTrue(np.all(np.diff(probabilities) >= 0))
        self.assertTrue(np.all((probabilities >= 0) & (probabilities <= 1)))

    def test_platt_scaling_rejects_single_class_calibration_data(self):
        with self.assertRaisesRegex(ValueError, "both delayed and on-time"):
            fit_platt_scaling(np.asarray([-1.0, 1.0]), np.asarray([0.0, 0.0]))


class EvaluationMetricTests(unittest.TestCase):
    def test_binary_metrics_for_known_results(self):
        metrics = evaluation_metrics(
            np.asarray([0, 0, 1, 1]),
            np.asarray([0.1, 0.7, 0.3, 0.9]),
        )
        self.assertEqual(metrics["precision"], 0.5)
        self.assertEqual(metrics["recall"], 0.5)
        self.assertEqual(metrics["f1"], 0.5)
        self.assertEqual(metrics["confusion_matrix_labels"], [0, 1])
        self.assertEqual(metrics["confusion_matrix"], [[1, 1], [1, 1]])
        self.assertEqual(metrics["roc_auc"], 0.75)
        self.assertAlmostEqual(metrics["brier_score"], 0.25)

    def test_auc_uses_average_ranks_for_tied_scores(self):
        metrics = evaluation_metrics(np.asarray([0, 1]), np.asarray([0.5, 0.5]))
        self.assertEqual(metrics["roc_auc"], 0.5)

    def test_auc_is_unavailable_when_test_labels_have_one_class(self):
        metrics = evaluation_metrics(np.asarray([0, 0]), np.asarray([0.2, 0.4]))
        self.assertIsNone(metrics["roc_auc"])

    def test_calibration_threshold_is_selected_without_using_test_data(self):
        threshold = choose_f1_threshold(np.asarray([0, 0, 1, 1]), np.asarray([0.1, 0.55, 0.6, 0.8]))
        self.assertEqual(threshold, 0.6)
        metrics = evaluation_metrics(np.asarray([0, 0, 1, 1]), np.asarray([0.1, 0.55, 0.6, 0.8]), threshold)
        self.assertEqual(metrics["threshold"], threshold)
        self.assertEqual(metrics["confusion_matrix"], [[2, 0], [0, 2]])

    def test_metrics_reject_non_probability_scores(self):
        with self.assertRaisesRegex(ValueError, "probabilities in \\[0, 1\\]"):
            evaluation_metrics(np.asarray([0, 1]), np.asarray([-0.1, 1.1]))


class FeaturePreparationTests(unittest.TestCase):
    def test_training_statistics_are_chunked_and_use_training_dates_only(self):
        frame = pd.DataFrame({"FlightDate": pd.to_datetime(["2023-01-01", "2023-01-02", "2023-02-01"])})
        for feature in FEATURES:
            frame[feature] = [1.0, 3.0, 100.0]
        mean, scale = training_feature_stats(frame, pd.Timestamp("2023-01-31"), chunk_size=1)
        np.testing.assert_allclose(mean, np.full(len(FEATURES), 2.0))
        np.testing.assert_allclose(scale, np.ones(len(FEATURES)))


if __name__ == "__main__":
    unittest.main()
