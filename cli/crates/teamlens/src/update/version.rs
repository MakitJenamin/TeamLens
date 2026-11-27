//! So sánh phiên bản theo semver 2.0 (đủ cho tag release `v<semver>`): `x.y.z`, hậu tố
//! prerelease `-rc.1` nhỏ hơn bản chính thức cùng số, metadata `+build` bỏ qua.

use std::cmp::Ordering;
use std::fmt;

/// Một phiên bản semver đã parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Các phần của prerelease (`rc.1` → `["rc", "1"]`), rỗng nếu là bản chính thức.
    pub pre: Vec<String>,
}

impl Version {
    /// Parse `x.y.z[-pre][+build]`, chấp nhận tiền tố `v` (tên tag). Sai dạng → `None`.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let text = text.strip_prefix('v').unwrap_or(text);
        let text = text.split('+').next()?;
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (text, None),
        };
        let mut parts = core.split('.');
        let mut num = || -> Option<u64> {
            let p = parts.next()?;
            if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            p.parse().ok()
        };
        let (major, minor, patch) = (num()?, num()?, num()?);
        if parts.next().is_some() {
            return None;
        }
        let pre = match pre {
            None => Vec::new(),
            Some(p) => {
                let ids: Vec<String> = p.split('.').map(str::to_owned).collect();
                let valid = ids.iter().all(|id| {
                    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                });
                if !valid {
                    return None;
                }
                ids
            }
        };
        Some(Self {
            major,
            minor,
            patch,
            pre,
        })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

/// So một phần prerelease: số so theo giá trị, số nhỏ hơn chữ, chữ so theo ASCII.
fn cmp_identifier(a: &str, b: &str) -> Ordering {
    let numeric = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    match (numeric(a), numeric(b)) {
        (true, true) => match (a.parse::<u64>(), b.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            _ => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
        },
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.cmp(b),
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                // Bản chính thức lớn hơn mọi prerelease cùng số.
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (a, b) in self.pre.iter().zip(&other.pre) {
                        let o = cmp_identifier(a, b);
                        if o != Ordering::Equal {
                            return o;
                        }
                    }
                    self.pre.len().cmp(&other.pre.len())
                }
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|| panic!("parse {s}"))
    }

    #[test]
    fn parse_dung_dang() {
        assert_eq!(v("0.1.0").to_string(), "0.1.0");
        assert_eq!(v("v1.2.3").to_string(), "1.2.3");
        assert_eq!(v(" v0.1.1-rc.1 ").to_string(), "0.1.1-rc.1");
        assert_eq!(v("1.0.0+build.5").to_string(), "1.0.0");
        assert!(v("0.2.0-beta").is_prerelease());
        assert!(!v("0.2.0").is_prerelease());
    }

    #[test]
    fn parse_sai_dang() {
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "a.b.c",
            "1.2.x",
            "1.2.3-",
            "1.2.3-rc..1",
            "v",
            "-1.2.3",
        ] {
            assert!(Version::parse(bad).is_none(), "{bad:?} phải bị từ chối");
        }
    }

    #[test]
    fn so_sanh_theo_semver() {
        assert!(v("0.1.1") > v("0.1.0"));
        assert!(v("0.2.0") > v("0.1.9"));
        assert!(v("1.0.0") > v("0.99.99"));
        assert!(v("0.1.10") > v("0.1.9"), "so số, không so chuỗi");
        assert_eq!(v("v0.1.0"), v("0.1.0"));
        assert_eq!(v("0.1.0+a").cmp(&v("0.1.0+b")), Ordering::Equal);
    }

    #[test]
    fn prerelease_nho_hon_ban_chinh_thuc() {
        assert!(v("0.1.1-rc.1") < v("0.1.1"));
        assert!(v("0.1.1-rc.1") > v("0.1.0"));
        assert!(v("0.1.1-rc.2") > v("0.1.1-rc.1"));
        assert!(v("0.1.1-rc.10") > v("0.1.1-rc.9"));
        assert!(v("1.0.0-alpha") < v("1.0.0-alpha.1"));
        assert!(v("1.0.0-alpha.1") < v("1.0.0-alpha.beta"));
        assert!(v("1.0.0-beta") > v("1.0.0-alpha.beta"));
        assert!(v("1.0.0-rc.1") > v("1.0.0-beta.11"));
    }
}
