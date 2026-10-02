// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Former flat names of the tools that moved into plugins, mapped to the
 * namespaced name the plugin registers.
 *
 * Migration `rename_extracted_tools` renames the catalog rows in place with the
 * same pairs, so an agent's enablement and a skill's tool links survive the move.
 * This map serves what the migration cannot reach: an export bundle written
 * before the move still names the old tool, and the importer translates it
 * here. A test holds the two lists equal.
 */
export const RENAMED_TOOLS: ReadonlyMap<string, string> = new Map([
  ["ghIssue", "github:issue"],
  ["ghPR", "github:pr"],
  ["gitCloneRepo", "github:cloneRepo"],
  ["renderService", "render:renderService"],
  ["hubspotContact", "hubspot:contact"],
  ["hubspotCreateTask", "hubspot:createTask"],
  ["hubspotDeal", "hubspot:deal"],
  ["hubspotFile", "hubspot:file"],
  ["hubspotGetCompany", "hubspot:getCompany"],
  ["hubspotMeeting", "hubspot:meeting"],
  ["hubspotNote", "hubspot:note"],
  ["hubspotSendEmail", "hubspot:sendEmail"],
  ["hubspotTicket", "hubspot:ticket"],
  ["markdownToPdf", "extra:markdownToPdf"],
]);

/** The current name of `name`: its namespaced successor, or itself. */
export function currentToolName(name: string): string {
  return RENAMED_TOOLS.get(name) ?? name;
}
