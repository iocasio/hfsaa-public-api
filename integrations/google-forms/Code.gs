/**
 * Bound Google Forms script for HFSAA Developer API applications.
 *
 * Required Script Properties:
 *   HFSAA_INGEST_URL   - Worker endpoint ending in
 *                        /v1/integrations/google-forms/applications
 *   HFSAA_INGEST_TOKEN - Dedicated Google Forms ingestion secret
 *
 * The form question titles must match QUESTION below. Do not put the
 * ingestion token in this file or in a spreadsheet cell.
 */

const QUESTION = Object.freeze({
  applicantName: "Name",
  email: "Email",
  organization: "Organization",
  website: "Website",
  requestedTier: "Access type",
  expectedMonthlyRequests: "Expected monthly requests",
  useCase: "How will you use the API?",
});

function answerMap_(response) {
  const answers = {};
  response.getItemResponses().forEach(function (itemResponse) {
    answers[itemResponse.getItem().getTitle()] = String(itemResponse.getResponse() || "").trim();
  });
  return answers;
}

function requiredAnswer_(answers, title) {
  const value = answers[title];
  if (!value) throw new Error("Missing required form answer: " + title);
  return value;
}

function onFormSubmit(e) {
  if (!e || !e.response) throw new Error("Run this function from an installable form-submit trigger.");

  const properties = PropertiesService.getScriptProperties();
  const ingestUrl = properties.getProperty("HFSAA_INGEST_URL");
  const ingestToken = properties.getProperty("HFSAA_INGEST_TOKEN");
  if (!ingestUrl || !ingestToken) throw new Error("HFSAA ingestion Script Properties are not configured.");

  const answers = answerMap_(e.response);
  const tierAnswer = requiredAnswer_(answers, QUESTION.requestedTier).toLowerCase();
  const requestedTier = tierAnswer.indexOf("production") >= 0 ? "production" : "test";
  const expectedAnswer = answers[QUESTION.expectedMonthlyRequests] || "";
  const expectedMonthlyRequests = expectedAnswer ? Number(expectedAnswer.replace(/,/g, "")) : null;
  if (expectedAnswer && (!Number.isInteger(expectedMonthlyRequests) || expectedMonthlyRequests < 1)) {
    throw new Error("Expected monthly requests must be a positive whole number.");
  }

  const payload = {
    source_response_id: e.response.getId(),
    applicant_name: requiredAnswer_(answers, QUESTION.applicantName),
    email: requiredAnswer_(answers, QUESTION.email),
    organization: answers[QUESTION.organization] || "",
    website: answers[QUESTION.website] || "",
    requested_tier: requestedTier,
    expected_monthly_requests: expectedMonthlyRequests,
    use_case: requiredAnswer_(answers, QUESTION.useCase),
  };

  const response = UrlFetchApp.fetch(ingestUrl, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + ingestToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error("HFSAA ingestion failed with HTTP " + status + ".");
  }
}

function installFormSubmitTrigger() {
  const form = FormApp.getActiveForm();
  if (!form) throw new Error("This Apps Script project must be bound to the HFSAA API request form.");

  ScriptApp.getProjectTriggers()
    .filter(function (trigger) { return trigger.getHandlerFunction() === "onFormSubmit"; })
    .forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });

  ScriptApp.newTrigger("onFormSubmit")
    .forForm(form)
    .onFormSubmit()
    .create();
}

