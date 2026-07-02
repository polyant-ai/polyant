// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture: a plugin tool that throws at module load. The loader must skip it
// (log + continue) instead of aborting engine boot.
throw new Error("boom: this plugin file explodes at import");
