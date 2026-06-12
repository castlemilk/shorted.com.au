import { beforeAll } from "vitest";
import { setProjectAnnotations } from "@storybook/nextjs-vite";
import * as projectAnnotations from "./preview";

// Apply all preview decorators, sb.mock registrations, and the project-level
// beforeEach (throwing defaults for unmocked spy calls) to every story test.
const project = setProjectAnnotations([projectAnnotations]);
beforeAll(project.beforeAll);
