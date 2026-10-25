import { expect, it } from "vitest";
import { checkDiscovery } from "../../scripts/check-test-discovery.mjs";

it("exige que todo archivo tenga tests en exactamente un proyecto", () => {
  expect(() => checkDiscovery(["a", "b"], [{ file: "a", projectName: "unit" }, { file: "a", projectName: "unit" }, { file: "b", projectName: "integration" }])).not.toThrow();
  expect(() => checkDiscovery(["a", "b"], [{ file: "a", projectName: "unit" }])).toThrow("Test omitido");
  expect(() => checkDiscovery(["a"], [{ file: "a", projectName: "unit" }, { file: "a", projectName: "integration" }])).toThrow("más de un proyecto");
  expect(() => checkDiscovery([], [])).toThrow("No se encontraron");
  expect(() => checkDiscovery(["a"], [{ file: "a", projectName: "unknown" }])).toThrow("Proyecto desconocido");
});
