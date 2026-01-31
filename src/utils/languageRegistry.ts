type LanguageSpec = {
  id: string;
  extensions: string[];
  filenames?: string[];
  monaco?: string;
};

const LANGUAGE_REGISTRY: LanguageSpec[] = [
  { id: "bash", extensions: ["bash", "sh"], monaco: "shell" },
  { id: "c", extensions: ["c", "h"] },
  { id: "cpp", extensions: ["cpp", "hpp"] },
  { id: "css", extensions: ["css"], monaco: "css" },
  { id: "graphql", extensions: ["gql", "graphql"], monaco: "graphql" },
  { id: "go", extensions: ["go"] },
  { id: "java", extensions: ["java"] },
  { id: "javascript", extensions: ["js", "mjs"], monaco: "javascript" },
  { id: "json", extensions: ["json"], monaco: "json" },
  { id: "jsx", extensions: ["jsx"], monaco: "javascript" },
  { id: "kotlin", extensions: ["kt"] },
  { id: "markdown", extensions: ["md"], monaco: "markdown" },
  { id: "php", extensions: ["php"] },
  { id: "prisma", extensions: ["prisma"], monaco: "prisma" },
  { id: "rust", extensions: ["rs"] },
  { id: "scss", extensions: ["sass", "scss"], monaco: "scss" },
  { id: "sql", extensions: ["sql"], monaco: "sql" },
  { id: "swift", extensions: ["swift"] },
  { id: "terraform", extensions: ["tf", "tfvars", "hcl"], monaco: "terraform" },
  { id: "toml", extensions: ["toml"] },
  { id: "typescript", extensions: ["ts"], monaco: "typescript" },
  { id: "tsx", extensions: ["tsx"], monaco: "typescript" },
  { id: "text", extensions: ["txt"], monaco: "plaintext" },
  { id: "xml", extensions: ["xml"] },
  { id: "yaml", extensions: ["yaml", "yml"], monaco: "yaml" },
  { id: "lua", extensions: ["lua"] },
  { id: "ruby", extensions: ["rb", "rake"] },
  { id: "markup", extensions: ["html"], monaco: "html" },
  { id: "dockerfile", extensions: [], filenames: ["dockerfile"], monaco: "dockerfile" },
];

const EXTENSION_TO_LANGUAGE = new Map<string, string>();
const FILENAME_TO_LANGUAGE = new Map<string, string>();
const LANGUAGE_TO_MONACO = new Map<string, string>();

for (const spec of LANGUAGE_REGISTRY) {
  for (const ext of spec.extensions) {
    EXTENSION_TO_LANGUAGE.set(ext, spec.id);
  }
  for (const name of spec.filenames ?? []) {
    FILENAME_TO_LANGUAGE.set(name.toLowerCase(), spec.id);
  }
  if (spec.monaco) {
    LANGUAGE_TO_MONACO.set(spec.id, spec.monaco);
  }
}

export function languageFromPath(path?: string | null) {
  if (!path) {
    return null;
  }
  const fileName = path.split("/").pop() ?? path;
  const lowerFile = fileName.toLowerCase();
  const filenameLanguage = FILENAME_TO_LANGUAGE.get(lowerFile);
  if (filenameLanguage) {
    return filenameLanguage;
  }
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return null;
  }
  const ext = fileName.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE.get(ext) ?? null;
}

export function monacoLanguageFromPath(path?: string | null) {
  const language = languageFromPath(path);
  if (!language) {
    return "plaintext";
  }
  if (language === "text") {
    return "plaintext";
  }
  return LANGUAGE_TO_MONACO.get(language) ?? "plaintext";
}
