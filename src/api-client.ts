export async function setVariantAnalysisRepoInProgress(
  variantAnalysisId: number,
  repoId: number
): Promise<void> {
  // makes call to PATCH /codeql/variant-analyses/:variant_analysis_id/repositories/:repo_id
}

export async function getSignedUrlForRepoArtifact(
  variantAnalysisId: number,
  repoId: number
): Promise<string> {
  // makes call to PUT /codeql/variant-analyses/:variant_analysis_id/repositories/:repo_id/artifact
  return "example.com";
}

export async function setVariantAnalysisRepoSucceeded(
  variantAnalysisId: number,
  repoId: number,
  sourceLocationPrefix: string,
  resultCount: number,
  databaseSHA: string
): Promise<void> {
  // makes call to PATCH /codeql/variant-analyses/:variant_analysis_id/repositories/:repo_id
}

export async function setVariantAnalysisFailed(
  variantAnalysisId: number,
  repoId: number,
  failureMessage: string
): Promise<void> {
  // makes call to PATCH /codeql/variant-analyses/:variant_analysis_id/repositories/:repo_id
}
