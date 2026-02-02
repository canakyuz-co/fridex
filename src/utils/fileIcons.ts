const ICON_BASE = "/icons/catppuccin/frappe";

const DEFAULT_FILE_ICON = `${ICON_BASE}/_file.svg`;
const DEFAULT_FOLDER_ICON = `${ICON_BASE}/_folder.svg`;
const DEFAULT_FOLDER_OPEN_ICON = `${ICON_BASE}/_folder_open.svg`;

const FOLDER_NAME_ICON_MAP = new Map<string, string>([
  ["src", "folder_src"],
  ["app", "folder_app"],
  ["apps", "folder_app"],
  ["assets", "folder_assets"],
  ["images", "folder_images"],
  ["img", "folder_images"],
  ["styles", "folder_styles"],
  ["style", "folder_styles"],
  ["components", "folder_components"],
  ["composables", "folder_composables"],
  ["hooks", "folder_hooks"],
  ["utils", "folder_utils"],
  ["lib", "folder_lib"],
  ["services", "folder_server"],
  ["server", "folder_server"],
  ["client", "folder_client"],
  ["public", "folder_public"],
  ["docs", "folder_docs"],
  ["test", "folder_tests"],
  ["tests", "folder_tests"],
  ["__tests__", "folder_tests"],
  ["spec", "folder_tests"],
  ["scripts", "folder_scripts"],
  ["config", "folder_config"],
  ["configs", "folder_config"],
  ["prisma", "folder_prisma"],
  ["database", "folder_database"],
  ["db", "folder_database"],
  ["migrations", "folder_database"],
  ["routes", "folder_routes"],
  ["views", "folder_views"],
  ["layouts", "folder_layouts"],
  ["types", "folder_types"],
  ["shared", "folder_shared"],
  ["packages", "folder_packages"],
  ["workflows", "folder_workflows"],
  [".github", "folder_github"],
  [".gitlab", "folder_gitlab"],
  [".vscode", "folder_vscode"],
  [".git", "folder_git"],
  ["node_modules", "folder_node"],
  ["cypress", "folder_cypress"],
  ["storybook", "folder_storybook"],
  ["coverage", "folder_coverage"],
  ["dist", "folder_dist"],
  ["fonts", "folder_fonts"],
  ["locales", "folder_locales"],
  ["i18n", "folder_locales"],
  ["middleware", "folder_middleware"],
  ["controllers", "folder_controllers"],
  ["core", "folder_core"],
  ["plugins", "folder_plugins"],
  ["templates", "folder_templates"],
  ["themes", "folder_themes"],
  ["api", "folder_api"],
  ["src-tauri", "folder_tauri"],
  ["tauri", "folder_tauri"],
]);

const FILE_NAME_ICON_MAP = new Map<string, string>([
  ["astro.config.mjs", "astro-config.svg"],
  ["astro.config.ts", "astro-config.svg"],
  ["astro.config.js", "astro-config.svg"],
  ["vite.config.ts", "vite.svg"],
  ["vite.config.js", "vite.svg"],
  ["vite.config.mjs", "vite.svg"],
  ["next.config.js", "next.svg"],
  ["next.config.mjs", "next.svg"],
  ["next.config.ts", "next.svg"],
  ["nuxt.config.ts", "nuxt.svg"],
  ["nuxt.config.js", "nuxt.svg"],
  ["remix.config.js", "remix.svg"],
  ["remix.config.ts", "remix.svg"],
  ["tailwind.config.js", "tailwind.svg"],
  ["tailwind.config.ts", "tailwind.svg"],
  ["postcss.config.js", "postcss.svg"],
  ["postcss.config.cjs", "postcss.svg"],
  ["postcss.config.mjs", "postcss.svg"],
  ["jest.config.js", "jest.svg"],
  ["jest.config.ts", "jest.svg"],
  ["vitest.config.ts", "vitest.svg"],
  ["vitest.config.mts", "vitest.svg"],
  ["playwright.config.ts", "playwright.svg"],
  ["playwright.config.mts", "playwright.svg"],
  ["storybook.config.ts", "storybook.svg"],
  ["storybook.config.js", "storybook.svg"],
  ["dockerfile", "docker.svg"],
  ["docker-compose.yml", "docker-compose.svg"],
  ["docker-compose.yaml", "docker-compose.svg"],
  ["dockerignore", "docker-ignore.svg"],
  [".dockerignore", "docker-ignore.svg"],
  [".gitignore", "git.svg"],
  [".gitattributes", "git.svg"],
  [".gitmodules", "git.svg"],
  ["package-lock.json", "lock.svg"],
  ["pnpm-lock.yaml", "lock.svg"],
  ["yarn.lock", "lock.svg"],
  ["cargo.lock", "lock.svg"],
  ["bun.lockb", "lock.svg"],
  ["bun.lock", "lock.svg"],
  ["tsconfig.json", "typescript-config.svg"],
  ["jsconfig.json", "javascript-config.svg"],
]);

const EXT_ICON_MAP = new Map<string, string>([
  ["ts", "typescript.svg"],
  ["tsx", "typescript-react.svg"],
  ["js", "javascript.svg"],
  ["jsx", "javascript-react.svg"],
  ["mjs", "javascript.svg"],
  ["cjs", "javascript.svg"],
  ["json", "json.svg"],
  ["md", "markdown.svg"],
  ["mdx", "markdown-mdx.svg"],
  ["html", "html.svg"],
  ["css", "css.svg"],
  ["scss", "sass.svg"],
  ["sass", "sass.svg"],
  ["less", "less.svg"],
  ["yaml", "yaml.svg"],
  ["yml", "yaml.svg"],
  ["toml", "toml.svg"],
  ["astro", "astro.svg"],
  ["svelte", "svelte.svg"],
  ["vue", "vue.svg"],
  ["solid", "solid.svg"],
  ["prisma", "prisma.svg"],
  ["graphql", "graphql.svg"],
  ["gql", "graphql.svg"],
  ["sql", "database.svg"],
  ["pcss", "postcss.svg"],
  ["svg", "svg.svg"],
  ["png", "image.svg"],
  ["jpg", "image.svg"],
  ["jpeg", "image.svg"],
  ["gif", "image.svg"],
  ["webp", "image.svg"],
  ["avif", "image.svg"],
  ["bmp", "image.svg"],
  ["tif", "image.svg"],
  ["tiff", "image.svg"],
  ["heic", "image.svg"],
  ["heif", "image.svg"],
  ["pdf", "pdf.svg"],
  ["txt", "text.svg"],
  ["log", "text.svg"],
  ["md", "markdown.svg"],
  ["sh", "bash.svg"],
  ["bash", "bash.svg"],
  ["zsh", "bash.svg"],
  ["c", "c.svg"],
  ["h", "c-header.svg"],
  ["cpp", "cpp.svg"],
  ["hpp", "cpp-header.svg"],
  ["cc", "cpp.svg"],
  ["cxx", "cpp.svg"],
  ["java", "java.svg"],
  ["kt", "kotlin.svg"],
  ["kts", "kotlin.svg"],
  ["swift", "swift.svg"],
  ["rb", "ruby.svg"],
  ["php", "php.svg"],
  ["cs", "csharp.svg"],
  ["ps1", "powershell.svg"],
  ["xml", "xml.svg"],
  ["ini", "config.svg"],
  ["conf", "config.svg"],
  ["config", "config.svg"],
  ["lua", "lua.svg"],
  ["dart", "dart.svg"],
  ["r", "r.svg"],
  ["rs", "rust.svg"],
  ["go", "go.svg"],
  ["py", "python.svg"],
  ["env", "env.svg"],
]);

type FileIconDescriptor = {
  src: string;
  label: string;
};

export function getFileIconDescriptor(
  path: string,
  isFolder: boolean,
  isOpen: boolean,
): FileIconDescriptor {
  if (isFolder) {
    const folderName = path.split("/").pop() ?? path;
    const lowerFolder = folderName.toLowerCase();
    const folderKey = FOLDER_NAME_ICON_MAP.get(lowerFolder);
    if (folderKey) {
      const suffix = isOpen ? "_open.svg" : ".svg";
      return {
        src: `${ICON_BASE}/${folderKey}${suffix}`,
        label: folderName,
      };
    }
    return {
      src: isOpen ? DEFAULT_FOLDER_OPEN_ICON : DEFAULT_FOLDER_ICON,
      label: "Folder",
    };
  }
  const baseName = path.split("/").pop() ?? path;
  const lowerName = baseName.toLowerCase();
  if (lowerName.startsWith(".env")) {
    return { src: `${ICON_BASE}/env.svg`, label: "Env" };
  }
  const exact = FILE_NAME_ICON_MAP.get(lowerName);
  if (exact) {
    return { src: `${ICON_BASE}/${exact}`, label: baseName };
  }
  if (lowerName.endsWith(".d.ts")) {
    return { src: `${ICON_BASE}/typescript-def.svg`, label: baseName };
  }
  const ext = lowerName.includes(".") ? lowerName.split(".").pop() ?? "" : "";
  const extIcon = EXT_ICON_MAP.get(ext);
  if (extIcon) {
    return { src: `${ICON_BASE}/${extIcon}`, label: baseName };
  }
  return { src: DEFAULT_FILE_ICON, label: baseName };
}
