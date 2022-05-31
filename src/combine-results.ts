import fs from "fs";
import path from "path";

import {
  ArtifactClient,
  create as createArtifactClient,
  DownloadResponse,
} from "@actions/artifact";
import { getInput, setFailed } from "@actions/core";
import { getOctokit } from "@actions/github";
import { mkdirP } from "@actions/io";

import { createResultIndex } from "./interpret";

async function run(): Promise<void> {
  try {
    const token = getInput("token", { required: true });

    const artifactClient = createArtifactClient();
    const [resultArtifacts, errorArtifacts] = await downloadArtifacts(
      artifactClient
    );

    // Fail if there are no result artifacts
    if (resultArtifacts.length === 0) {
      setFailed("Unable to run query on any repositories.");
      return;
    }

    // Check for any cancelled jobs using https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run
    const octokit = getOctokit(token);
    const cancelledJobsResponse = await octokit.request(
      `GET /repos/${process.env["GITHUB_REPOSITORY"]}/actions/runs/${process.env["GITHUB_RUN_ID"]}/jobs`
    );
    const cancelledJobs = cancelledJobsResponse.data.jobs.filter(
      (job) => job.conclusion === "cancelled"
    );
    if (cancelledJobs.length > 0) {
      const jobIds = cancelledJobs.map((job) => job.id);
      console.log(jobIds.join(", "));
    }

    await mkdirP("results");
    await uploadResultIndex(resultArtifacts, errorArtifacts, artifactClient);
  } catch (error: any) {
    setFailed(error.message);
  }
}

async function downloadArtifacts(
  artifactClient: ArtifactClient
): Promise<[DownloadResponse[], DownloadResponse[]]> {
  await mkdirP("artifacts");
  const downloadResponse = await artifactClient.downloadAllArtifacts(
    "artifacts"
  );

  // See if there are any "error" artifacts and if so, let the user know in the issue
  const errorArtifacts = downloadResponse.filter((artifact) =>
    artifact.artifactName.includes("error")
  );

  // Result artifacts are the non-error artifacts
  const resultArtifacts = downloadResponse.filter(
    (artifact) => !errorArtifacts.includes(artifact)
  );

  return [resultArtifacts, errorArtifacts];
}

async function uploadResultIndex(
  resultArtifacts: DownloadResponse[],
  errorArtifacts: DownloadResponse[],
  artifactClient: ArtifactClient
) {
  const resultsIndex = createResultIndex(resultArtifacts, errorArtifacts);

  // Create the index.json file
  const resultIndexFile = path.join("results", "index.json");
  await fs.promises.writeFile(
    resultIndexFile,
    JSON.stringify(resultsIndex, null, 2)
  );

  await artifactClient.uploadArtifact(
    "result-index", // name
    [resultIndexFile], // files
    "results", // rootdirectory
    { continueOnError: false }
  );
}

void run();
