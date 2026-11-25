import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Link, redirect, useRouter... tự thêm prefix locale khi cần.
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
