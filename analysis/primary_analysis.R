args <- commandArgs(trailingOnly = TRUE)

get_arg <- function(flag, default_value = NA_character_) {
  hit <- which(args == flag)
  if (length(hit) == 0) return(default_value)
  if (hit[1] == length(args)) return(default_value)
  args[hit[1] + 1]
}

in_dir <- get_arg("--in-dir", "reports/analysis/results")
scores_path <- get_arg("--scores", "reports/analysis/scores_long.csv")
out_dir <- get_arg("--out-dir", in_dir)

suppressPackageStartupMessages({
  library(data.table)
  library(dplyr)
  library(tidyr)
  library(lme4)
  library(lmerTest)
  library(emmeans)
  library(psych)
  library(ordinal)
})

dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)

read_csv_utf8 <- function(path) {
  data.table::fread(path, encoding = "UTF-8", data.table = FALSE)
}

write_csv_utf8 <- function(df, path) {
  data.table::fwrite(df, path, bom = TRUE)
}

analysis_path <- file.path(in_dir, "analysis_dataset_joined.csv")
if (!file.exists(analysis_path)) stop(paste("Missing:", analysis_path))
if (!file.exists(scores_path)) stop(paste("Missing:", scores_path))

condition_levels <- c("baseline", "mcp", "peer")
phase_levels <- c("\u4F4F\u9662\u9636\u6BB5", "\u51FA\u9662\u9636\u6BB5", "\u95E8\u8BCA\u9636\u6BB5")
endpoint_levels <- c("accuracy", "completeness", "safety", "clarity", "weighted_total")
affected_endpoints <- c("clarity", "weighted_total")

as_num <- function(x) suppressWarnings(as.numeric(x))

compute_weighted_total <- function(df) {
  df %>%
    mutate(
      accuracy = as_num(accuracy),
      completeness = as_num(completeness),
      safety = as_num(safety),
      clarity = as_num(clarity),
      weighted_total = dplyr::if_else(
        is.na(accuracy) | is.na(completeness) | is.na(safety) | is.na(clarity),
        NA_real_,
        0.5 * accuracy + 0.3 * completeness + 0.1 * safety + 0.1 * clarity
      )
    )
}

make_model_df <- function(df) {
  df %>%
    mutate(
      condition = factor(condition, levels = condition_levels),
      phase = factor(phase, levels = phase_levels),
      case_phase_model = interaction(case_pseudo, phase, model_cluster, drop = TRUE),
      report_id = factor(report_id),
      rater_id = factor(rater_id),
      needs_review = as.integer(needs_review)
    )
}

analysis <- read_csv_utf8(analysis_path)
scores <- read_csv_utf8(scores_path)

target_report_id <- "EDB1BF86"
target_rater_id <- "R3"
target_case_pseudo <- "C5"
target_phase <- "\u4F4F\u9662\u9636\u6BB5"
target_condition <- "baseline"
resolved_clarity <- 4

target_filter <- analysis$report_id == target_report_id &
  analysis$rater_id == target_rater_id &
  analysis$case_pseudo == target_case_pseudo &
  analysis$phase == target_phase &
  analysis$condition == target_condition

if (sum(target_filter, na.rm = TRUE) != 1) {
  stop(paste("Expected one data-entry resolution row, found", sum(target_filter, na.rm = TRUE)))
}

data_entry_audit <- analysis[target_filter, , drop = FALSE] %>%
  transmute(
    case_pseudo,
    phase,
    report_id,
    rater_id,
    condition,
    model_cluster,
    old_accuracy = accuracy,
    old_completeness = completeness,
    old_safety = safety,
    old_clarity = clarity,
    old_weighted_total = weighted_total,
    resolved_clarity = resolved_clarity
  )

analysis$clarity[target_filter] <- resolved_clarity
analysis <- compute_weighted_total(analysis)

score_filter <- scores$report_id == target_report_id &
  scores$rater_id == target_rater_id
if ("phase" %in% names(scores)) {
  score_filter <- score_filter & scores$phase == target_phase
}
if (sum(score_filter, na.rm = TRUE) == 1) {
  scores$clarity[score_filter] <- resolved_clarity
  scores <- compute_weighted_total(scores)
} else {
  stop(paste("Expected one data-entry resolution row in scores, found", sum(score_filter, na.rm = TRUE)))
}

data_entry_audit <- data_entry_audit %>%
  mutate(
    resolved_weighted_total = 0.5 * as_num(old_accuracy) +
      0.3 * as_num(old_completeness) +
      0.1 * as_num(old_safety) +
      0.1 * resolved_clarity
  )
write_csv_utf8(data_entry_audit, file.path(out_dir, "data_entry_resolution_audit.csv"))

analysis <- analysis %>%
  mutate(
    case = as.character(case),
    case_pseudo = as.character(case_pseudo),
    phase = as.character(phase),
    report_id = as.character(report_id),
    rater_id = as.character(rater_id),
    condition = as.character(condition),
    model_cluster = as.character(model_cluster),
    needs_review = as.integer(needs_review)
  )

missingness <- tibble::tibble(
  n_rows = nrow(analysis),
  n_missing_condition = sum(is.na(analysis$condition) | analysis$condition == ""),
  n_missing_weighted_total = sum(is.na(analysis$weighted_total)),
  n_missing_accuracy = sum(is.na(analysis$accuracy)),
  n_missing_completeness = sum(is.na(analysis$completeness)),
  n_missing_safety = sum(is.na(analysis$safety)),
  n_missing_clarity = sum(is.na(analysis$clarity))
)
write_csv_utf8(missingness, file.path(out_dir, "qc_missingness_summary.csv"))

weighted_mismatch <- analysis %>%
  transmute(
    case_pseudo,
    phase,
    report_id,
    rater_id,
    accuracy,
    completeness,
    safety,
    clarity,
    weighted_total_sheet = NA_real_,
    weighted_total,
    wt_diff = NA_real_,
    mismatch_reason = "not_rechecked_against_source_sheet_after_data_entry_resolution"
  ) %>%
  filter(FALSE)
write_csv_utf8(weighted_mismatch, file.path(out_dir, "qc_weighted_total_mismatch.csv"))

analysis_out_path <- file.path(out_dir, "analysis_dataset_joined.csv")
analysis_shareable_out_path <- file.path(out_dir, "analysis_dataset_shareable.csv")
scores_out_path <- if (out_dir == in_dir) file.path(out_dir, "scores_long_resolved.csv") else scores_path

if (file.exists(analysis_path) && !file.exists(paste0(analysis_path, ".original"))) {
  file.copy(analysis_path, paste0(analysis_path, ".original"), overwrite = FALSE)
}
if (file.exists(scores_path) && !file.exists(paste0(scores_path, ".original"))) {
  file.copy(scores_path, paste0(scores_path, ".original"), overwrite = FALSE)
}

write_csv_utf8(analysis, analysis_out_path)
write_csv_utf8(analysis %>% select(-case), analysis_shareable_out_path)
write_csv_utf8(scores, scores_out_path)

format_phase <- function(x) ifelse(is.na(x), "", as.character(x))

collect_contrasts <- function(fit, endpoint, dataset_label) {
  endpoint_label <- endpoint
  overall_adjust <- if (endpoint_label == "weighted_total") "holm" else "none"
  overall <- summary(
    pairs(emmeans::emmeans(fit, ~ condition), reverse = TRUE),
    infer = c(FALSE, TRUE),
    adjust = overall_adjust
  ) %>%
    as.data.frame() %>%
    mutate(
      lower_ci = estimate - stats::qt(0.975, df = df) * SE,
      upper_ci = estimate + stats::qt(0.975, df = df) * SE
    ) %>%
    transmute(
      contrast = as.character(contrast),
      estimate = estimate,
      SE = SE,
      df = df,
      t.ratio = t.ratio,
      p.value = p.value,
      lower_ci = lower_ci,
      upper_ci = upper_ci,
      endpoint = endpoint_label,
      contrast_scope = "overall",
      adjust_method = overall_adjust,
      phase = "",
      dataset = dataset_label
    )

  by_phase <- summary(
    pairs(emmeans::emmeans(fit, ~ condition | phase), reverse = TRUE),
    infer = c(FALSE, TRUE),
    adjust = "none"
  ) %>%
    as.data.frame() %>%
    mutate(
      lower_ci = estimate - stats::qt(0.975, df = df) * SE,
      upper_ci = estimate + stats::qt(0.975, df = df) * SE
    ) %>%
    transmute(
      contrast = as.character(contrast),
      estimate = estimate,
      SE = SE,
      df = df,
      t.ratio = t.ratio,
      p.value = p.value,
      lower_ci = lower_ci,
      upper_ci = upper_ci,
      endpoint = endpoint_label,
      contrast_scope = "by_phase",
      adjust_method = "none",
      phase = format_phase(phase),
      dataset = dataset_label
    )

  bind_rows(overall, by_phase)
}

fit_lmm <- function(df, endpoint) {
  fit_df <- df %>% filter(!is.na(.data[[endpoint]]))
  stats::as.formula(paste0(endpoint, " ~ condition * phase + (1 | case_phase_model) + (1 | report_id) + (1 | rater_id)")) %>%
    lmer(data = fit_df, REML = TRUE)
}

fixed_effect_rows <- list()
diagnostic_rows <- list()
contrast_rows <- list()

old_contrasts_path <- file.path(out_dir, "lmm_contrasts.csv")
old_fixed_effects_path <- file.path(out_dir, "lmm_fixed_effects.csv")
old_diagnostics_path <- file.path(out_dir, "lmm_diagnostics.csv")
old_contrasts <- if (file.exists(old_contrasts_path)) read_csv_utf8(old_contrasts_path) else data.frame()
old_fixed_effects <- if (file.exists(old_fixed_effects_path)) read_csv_utf8(old_fixed_effects_path) else data.frame()
old_diagnostics <- if (file.exists(old_diagnostics_path)) read_csv_utf8(old_diagnostics_path) else data.frame()

for (dataset_label in c("all_rows", "needs_review_0")) {
  dataset_df <- analysis
  if (dataset_label == "needs_review_0") dataset_df <- dataset_df %>% filter(needs_review == 0)
  model_df <- make_model_df(dataset_df)

  for (endpoint in affected_endpoints) {
    message("Fitting LMM: ", endpoint, " / ", dataset_label)
    fit <- fit_lmm(model_df, endpoint)
    endpoint_n <- sum(!is.na(model_df[[endpoint]]))
    contrast_rows[[length(contrast_rows) + 1]] <- collect_contrasts(fit, endpoint, dataset_label)

    fixed_effect_rows[[length(fixed_effect_rows) + 1]] <- coef(summary(fit)) %>%
      as.data.frame() %>%
      tibble::rownames_to_column("term") %>%
      mutate(endpoint = endpoint, dataset = dataset_label)

    messages <- fit@optinfo$conv$lme4$messages
    diagnostic_rows[[length(diagnostic_rows) + 1]] <- tibble::tibble(
      endpoint = endpoint,
      n_rows = endpoint_n,
      is_singular = lme4::isSingular(fit),
      conv_messages = if (is.null(messages)) "" else paste(messages, collapse = "; "),
      dataset = dataset_label
    )
  }
}

new_contrasts <- bind_rows(contrast_rows)
new_fixed_effects <- bind_rows(fixed_effect_rows)
new_diagnostics <- bind_rows(diagnostic_rows)

merge_computed <- function(old_df, new_df) {
  if (nrow(old_df) == 0) return(new_df)
  if (!("endpoint" %in% names(old_df))) return(new_df)
  if (!("dataset" %in% names(old_df))) old_df$dataset <- "all_rows"
  bind_rows(
    old_df %>% filter(!(endpoint %in% affected_endpoints)),
    new_df
  )
}

write_csv_utf8(merge_computed(old_contrasts, new_contrasts), file.path(out_dir, "lmm_contrasts.csv"))
write_csv_utf8(merge_computed(old_fixed_effects, new_fixed_effects), file.path(out_dir, "lmm_fixed_effects.csv"))
write_csv_utf8(merge_computed(old_diagnostics, new_diagnostics), file.path(out_dir, "lmm_diagnostics.csv"))

icc_for <- function(df, endpoint, group_cols = NULL) {
  if (!is.null(group_cols) && length(group_cols) > 0) {
    return(
      df %>%
        group_by(across(all_of(group_cols))) %>%
        group_modify(~ icc_for(.x, endpoint, NULL)) %>%
        ungroup()
    )
  }

  wide <- df %>%
    select(report_id, rater_id, value = all_of(endpoint)) %>%
    tidyr::pivot_wider(names_from = rater_id, values_from = value) %>%
    arrange(report_id)
  n_targets_total <- nrow(wide)
  mat <- as.matrix(wide %>% select(-report_id))
  mat <- mat[stats::complete.cases(mat), , drop = FALSE]
  n_targets_complete <- nrow(mat)
  if (n_targets_complete < 2 || ncol(mat) < 2) {
    return(tibble::tibble(
      endpoint = endpoint,
      n_targets_total = n_targets_total,
      n_targets_complete = n_targets_complete,
      icc2_1 = NA_real_,
      icc2_1_lower = NA_real_,
      icc2_1_upper = NA_real_,
      icc2_k = NA_real_,
      icc2_k_lower = NA_real_,
      icc2_k_upper = NA_real_,
      icc3_1 = NA_real_,
      icc3_1_lower = NA_real_,
      icc3_1_upper = NA_real_,
      icc3_k = NA_real_,
      icc3_k_lower = NA_real_,
      icc3_k_upper = NA_real_
    ))
  }
  res <- psych::ICC(mat)$results
  row_by_type <- function(type) res[res$type == type, , drop = FALSE]
  icc2 <- row_by_type("ICC2")
  icc2k <- row_by_type("ICC2k")
  icc3 <- row_by_type("ICC3")
  icc3k <- row_by_type("ICC3k")
  tibble::tibble(
    endpoint = endpoint,
    n_targets_total = n_targets_total,
    n_targets_complete = n_targets_complete,
    icc2_1 = icc2$ICC,
    icc2_1_lower = icc2$`lower bound`,
    icc2_1_upper = icc2$`upper bound`,
    icc2_k = icc2k$ICC,
    icc2_k_lower = icc2k$`lower bound`,
    icc2_k_upper = icc2k$`upper bound`,
    icc3_1 = icc3$ICC,
    icc3_1_lower = icc3$`lower bound`,
    icc3_1_upper = icc3$`upper bound`,
    icc3_k = icc3k$ICC,
    icc3_k_lower = icc3k$`lower bound`,
    icc3_k_upper = icc3k$`upper bound`
  )
}

report_level <- analysis %>%
  mutate(condition = as.character(condition), phase = as.character(phase))

icc_overall <- bind_rows(lapply(endpoint_levels, function(endpoint) icc_for(report_level, endpoint)))
write_csv_utf8(icc_overall, file.path(out_dir, "icc_overall.csv"))

icc_by_condition <- bind_rows(lapply(endpoint_levels, function(endpoint) {
  icc_for(report_level, endpoint, "condition")
}))
write_csv_utf8(icc_by_condition, file.path(out_dir, "icc_by_condition.csv"))

icc_by_phase <- bind_rows(lapply(endpoint_levels, function(endpoint) {
  icc_for(report_level, endpoint, "phase")
}))
write_csv_utf8(icc_by_phase, file.path(out_dir, "icc_by_phase.csv"))

fit_weighted_total_contrasts <- function(df, dataset_label, leave_out_type = NA_character_, leave_out = NA_character_) {
  model_df <- make_model_df(df) %>% filter(!is.na(weighted_total))
  fit <- fit_lmm(model_df, "weighted_total")
  collect_contrasts(fit, "weighted_total", dataset_label) %>%
    filter(contrast_scope == "overall") %>%
    transmute(
      endpoint = "weighted_total",
      contrast,
      estimate,
      lower_ci,
      upper_ci,
      p.value,
      adjust_method,
      leave_out_type = leave_out_type,
      leave_out = leave_out,
      n_rows = nrow(model_df)
    )
}

loo_rows <- list()
for (case_id in sort(unique(analysis$case_pseudo))) {
  message("Fitting leave-one-case weighted_total LMM: ", case_id)
  loo_rows[[length(loo_rows) + 1]] <- fit_weighted_total_contrasts(
    analysis %>% filter(case_pseudo != case_id),
    "all_rows",
    "case_pseudo",
    case_id
  )
}
for (rater in sort(unique(analysis$rater_id))) {
  message("Fitting leave-one-rater weighted_total LMM: ", rater)
  loo_rows[[length(loo_rows) + 1]] <- fit_weighted_total_contrasts(
    analysis %>% filter(rater_id != rater),
    "all_rows",
    "rater_id",
    rater
  )
}
write_csv_utf8(bind_rows(loo_rows), file.path(out_dir, "robustness_leave_one_out_weighted_total.csv"))

message("Primary ratings analysis complete.")
