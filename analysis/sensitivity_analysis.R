args <- commandArgs(trailingOnly = TRUE)

get_arg <- function(flag, default_value = NA_character_) {
  hit <- which(args == flag)
  if (length(hit) == 0) return(default_value)
  if (hit[1] == length(args)) return(default_value)
  args[hit[1] + 1]
}

in_dir <- get_arg("--in-dir", "reports/analysis/results")
out_dir <- get_arg("--out-dir", in_dir)

suppressPackageStartupMessages({
  library(data.table)
  library(dplyr)
  library(tidyr)
  library(lme4)
  library(lmerTest)
  library(emmeans)
})

read_csv_utf8 <- function(path) {
  data.table::fread(path, encoding = "UTF-8", data.table = FALSE)
}

write_csv_utf8 <- function(df, path) {
  data.table::fwrite(df, path, bom = TRUE)
}

analysis_path <- file.path(in_dir, "analysis_dataset_joined.csv")
old_loo_path <- file.path(in_dir, "robustness_leave_one_out_weighted_total.csv")
if (!file.exists(analysis_path)) stop(paste("Missing:", analysis_path))
if (!file.exists(old_loo_path)) stop(paste("Missing:", old_loo_path))

condition_levels <- c("baseline", "mcp", "peer")
phase_levels <- c("\u4F4F\u9662\u9636\u6BB5", "\u51FA\u9662\u9636\u6BB5", "\u95E8\u8BCA\u9636\u6BB5")
target_case_pseudo <- "C5"
target_rater_id <- "R3"

analysis <- read_csv_utf8(analysis_path) %>%
  mutate(
    weighted_total = suppressWarnings(as.numeric(weighted_total)),
    needs_review = as.integer(needs_review)
  )

old_loo <- read_csv_utf8(old_loo_path)

make_model_df <- function(df) {
  df %>%
    mutate(
      condition = factor(condition, levels = condition_levels),
      phase = factor(phase, levels = phase_levels),
      case_phase_model = interaction(case_pseudo, phase, model_cluster, drop = TRUE),
      report_id = factor(report_id),
      rater_id = factor(rater_id)
    )
}

collect_contrasts <- function(fit, n_rows, leave_out_type, leave_out) {
  summary(
    pairs(emmeans::emmeans(fit, ~ condition), reverse = TRUE),
    infer = c(FALSE, TRUE),
    adjust = "holm"
  ) %>%
    as.data.frame() %>%
    mutate(
      lower_ci = estimate - stats::qt(0.975, df = df) * SE,
      upper_ci = estimate + stats::qt(0.975, df = df) * SE
    ) %>%
    transmute(
      endpoint = "weighted_total",
      contrast = as.character(contrast),
      estimate = estimate,
      lower_ci = lower_ci,
      upper_ci = upper_ci,
      p.value = p.value,
      adjust_method = "holm",
      leave_out_type = leave_out_type,
      leave_out = leave_out,
      n_rows = n_rows
    )
}

fit_subset <- function(df, leave_out_type, leave_out) {
  model_df <- make_model_df(df) %>% filter(!is.na(weighted_total))
  message("Fitting weighted_total leave-one-out: ", leave_out_type, "=", leave_out, " (n=", nrow(model_df), ")")
  fit <- lmer(
    weighted_total ~ condition * phase + (1 | case_phase_model) + (1 | report_id) + (1 | rater_id),
    data = model_df,
    REML = TRUE
  )
  collect_contrasts(fit, nrow(model_df), leave_out_type, leave_out)
}

affected_case_ids <- setdiff(sort(unique(analysis$case_pseudo)), target_case_pseudo)
affected_raters <- setdiff(sort(unique(analysis$rater_id)), target_rater_id)

new_rows <- list()
for (case_id in affected_case_ids) {
  new_rows[[length(new_rows) + 1]] <- fit_subset(
    analysis %>% filter(case_pseudo != case_id),
    "case_pseudo",
    case_id
  )
}
for (rater in affected_raters) {
  new_rows[[length(new_rows) + 1]] <- fit_subset(
    analysis %>% filter(rater_id != rater),
    "rater_id",
    rater
  )
}

unchanged_rows <- old_loo %>%
  filter(
    (leave_out_type == "case_pseudo" & leave_out == target_case_pseudo) |
      (leave_out_type == "rater_id" & leave_out == target_rater_id)
  )

combined <- bind_rows(unchanged_rows, bind_rows(new_rows)) %>%
  mutate(
    leave_out_type = factor(leave_out_type, levels = c("case_pseudo", "rater_id")),
    leave_out = as.character(leave_out),
    contrast = factor(contrast, levels = c("mcp - baseline", "peer - baseline", "peer - mcp"))
  ) %>%
  arrange(leave_out_type, leave_out, contrast) %>%
  mutate(
    leave_out_type = as.character(leave_out_type),
    contrast = as.character(contrast)
  )

if (file.exists(old_loo_path) && !file.exists(paste0(old_loo_path, ".original"))) {
  file.copy(old_loo_path, paste0(old_loo_path, ".original"), overwrite = FALSE)
}
write_csv_utf8(combined, old_loo_path)

audit <- tibble::tibble(
  table = "robustness_leave_one_out_weighted_total.csv",
  data_entry_resolution = "source-recorded clarity for C5/R3/report EDB1BF86 = 4; weighted_total = 3.1",
  computed_case_leave_outs = paste(affected_case_ids, collapse = ";"),
  computed_rater_leave_outs = paste(affected_raters, collapse = ";"),
  retained_unchanged_leave_outs = paste(c(target_case_pseudo, target_rater_id), collapse = ";"),
  rows_written = nrow(combined)
)
write_csv_utf8(audit, file.path(out_dir, "sensitivity_analysis_audit.csv"))

message("Sensitivity analysis complete.")

# Optional confirmatory inference for revision round 2. This block requires the
# same row-level analysis export as the main model and writes only aggregate
# contrast-level outputs. It must not be copied into public manuscript text until
# rerun against the governed rating dataset.
fit_case_random_intercept <- function(df) {
  model_df <- make_model_df(df) %>%
    filter(!is.na(weighted_total)) %>%
    mutate(case_pseudo = factor(case_pseudo))
  fit <- lmer(
    weighted_total ~ condition * phase +
      (1 | case_pseudo) + (1 | case_phase_model) + (1 | report_id) + (1 | rater_id),
    data = model_df,
    REML = TRUE
  )
  summary(
    pairs(emmeans::emmeans(fit, ~ condition), reverse = TRUE),
    infer = c(FALSE, TRUE),
    adjust = "holm"
  ) %>%
    as.data.frame() %>%
    mutate(
      lower_ci = estimate - stats::qt(0.975, df = df) * SE,
      upper_ci = estimate + stats::qt(0.975, df = df) * SE
    ) %>%
    transmute(
      model = "case_random_intercept",
      contrast = as.character(contrast),
      estimate = estimate,
      lower_ci = lower_ci,
      upper_ci = upper_ci,
      p.value = p.value,
      adjust_method = "holm",
      n_rows = nrow(model_df),
      n_cases = dplyr::n_distinct(model_df$case_pseudo)
    )
}

case_random_intercept <- fit_case_random_intercept(analysis)
write_csv_utf8(
  case_random_intercept,
  file.path(out_dir, "case_random_intercept_weighted_total_contrasts.csv")
)

case_cluster_permutation <- function(df) {
  case_condition_means <- df %>%
    filter(!is.na(weighted_total)) %>%
    group_by(case_pseudo, condition) %>%
    summarise(mean_weighted_total = mean(weighted_total), .groups = "drop") %>%
    tidyr::pivot_wider(
      names_from = condition,
      values_from = mean_weighted_total
    )

  paired_diffs <- bind_rows(
    case_condition_means %>%
      transmute(case_pseudo, contrast = "mcp - baseline", difference = mcp - baseline),
    case_condition_means %>%
      transmute(case_pseudo, contrast = "peer - baseline", difference = peer - baseline),
    case_condition_means %>%
      transmute(case_pseudo, contrast = "peer - mcp", difference = peer - mcp)
  ) %>%
    filter(!is.na(difference))

  observed <- paired_diffs %>%
    group_by(contrast) %>%
    summarise(
      observed_case_mean_difference = mean(difference),
      observed_t = mean(difference) / (stats::sd(difference) / sqrt(dplyr::n())),
      n_cases = dplyr::n(),
      .groups = "drop"
    )

  n_cases <- dplyr::n_distinct(paired_diffs$case_pseudo)
  if (n_cases != 10L) {
    warning("Expected 10 case clusters for exact sign-flip enumeration; observed ", n_cases, ".")
  }

  case_levels <- sort(unique(paired_diffs$case_pseudo))
  sign_grid <- expand.grid(
    rep(list(c(-1, 1)), length(case_levels)),
    KEEP.OUT.ATTRS = FALSE
  )
  names(sign_grid) <- case_levels

  perm_rows <- vector("list", nrow(sign_grid))
  for (i in seq_len(nrow(sign_grid))) {
    signs <- tibble::tibble(
      case_pseudo = case_levels,
      sign = as.numeric(unlist(sign_grid[i, case_levels], use.names = FALSE))
    )
    perm_rows[[i]] <- paired_diffs %>%
      left_join(signs, by = "case_pseudo") %>%
      mutate(perm_difference = difference * sign) %>%
      group_by(contrast) %>%
      summarise(
        perm_estimate = mean(perm_difference),
        perm_t = mean(perm_difference) / (stats::sd(perm_difference) / sqrt(dplyr::n())),
        .groups = "drop"
      ) %>%
      mutate(assignment = i)
  }

  perm <- bind_rows(perm_rows)
  max_abs_t <- perm %>%
    group_by(assignment) %>%
    summarise(max_abs_t = max(abs(perm_t), na.rm = TRUE), .groups = "drop")

  perm %>%
    left_join(max_abs_t, by = "assignment") %>%
    left_join(observed, by = "contrast") %>%
    group_by(contrast, observed_case_mean_difference, observed_t, n_cases) %>%
    summarise(
      n_assignments = dplyr::n(),
      exact_p_two_sided = mean(abs(perm_t) >= abs(observed_t), na.rm = TRUE),
      max_abs_t_familywise_p = mean(max_abs_t >= abs(observed_t), na.rm = TRUE),
      .groups = "drop"
    ) %>%
    mutate(
      n_permutations_completed = n_assignments,
      permutation_p_two_sided = exact_p_two_sided,
      inference = "exact complete sign-flip enumeration over case clusters; max_abs_t_familywise_p adjusts across the three primary contrasts"
    )
}

case_perm <- case_cluster_permutation(analysis)
write_csv_utf8(
  case_perm,
  file.path(out_dir, "case_cluster_permutation_weighted_total.csv")
)

message("Case-random-intercept and case-cluster permutation outputs written.")
q(save = "no", status = 0, runLast = FALSE)
