// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Input } from "./input";
import { Select, SelectTrigger, SelectValue } from "./select";
import { Field, FieldControl, FieldDescription, FieldError, FieldLabel } from "./field";

describe("Field", () => {
  it("ties the description to the control", () => {
    render(
      <Field>
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
        <FieldDescription>Shown to users</FieldDescription>
      </Field>,
    );
    const input = screen.getByLabelText("Name");
    expect(input).toHaveAttribute("aria-describedby", screen.getByText("Shown to users").id);
    expect(input).toHaveAccessibleDescription("Shown to users");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("marks the control invalid and describes it with the error", () => {
    render(
      <Field>
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
        <FieldDescription>Help</FieldDescription>
        <FieldError>Required</FieldError>
      </Field>,
    );
    const input = screen.getByLabelText("Name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
    expect(input).toHaveAccessibleDescription("Help Required");
  });

  it("omits aria-describedby with no description or error", () => {
    render(
      <Field>
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
      </Field>,
    );
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-describedby");
  });

  it("leaves no dangling id when the description is empty", () => {
    render(
      <Field>
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input />
        </FieldControl>
        <FieldDescription>{""}</FieldDescription>
        <FieldError>{false}</FieldError>
      </Field>,
    );
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-describedby");
  });

  it("merges an existing aria-describedby", () => {
    render(
      <Field>
        <FieldLabel>Name</FieldLabel>
        <FieldControl>
          <Input aria-describedby="other" />
        </FieldControl>
        <FieldDescription>Help</FieldDescription>
      </Field>,
    );
    const ids = screen.getByLabelText("Name").getAttribute("aria-describedby")?.split(" ");
    expect(ids).toContain("other");
    expect(ids).toContain(screen.getByText("Help").id);
  });

  it("works on a SelectTrigger", () => {
    render(
      <Field>
        <FieldLabel>Mode</FieldLabel>
        <Select>
          <FieldControl>
            <SelectTrigger>
              <SelectValue placeholder="Pick" />
            </SelectTrigger>
          </FieldControl>
        </Select>
        <FieldDescription>Choose one</FieldDescription>
      </Field>,
    );
    expect(screen.getByRole("combobox")).toHaveAccessibleDescription("Choose one");
  });
});
