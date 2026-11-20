// Avatar(对齐 components/ui/Avatar.tsx):图片头像或首字母占位。
use leptos::prelude::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AvatarSize {
    Sm,
    #[default]
    Md,
    Lg,
}

impl AvatarSize {
    pub fn as_class(self) -> &'static str {
        match self {
            AvatarSize::Sm => "avatar-sm",
            AvatarSize::Md => "avatar-md",
            AvatarSize::Lg => "avatar-lg",
        }
    }
}

fn initials_of(name: &str) -> String {
    name.split_whitespace()
        .filter(|part| !part.is_empty())
        .take(2)
        .filter_map(|part| part.chars().next())
        .collect()
}

#[component]
pub fn Avatar(
    #[prop(into)] name: String,
    #[prop(optional, into)] alt: Option<String>,
    #[prop(default = AvatarSize::Md)] size: AvatarSize,
    #[prop(optional, into)] src: Option<String>,
) -> impl IntoView {
    let size_class = size.as_class();

    if let Some(src) = src {
        let alt_text = alt.unwrap_or_else(|| name.clone());
        return view! {
            <img alt={alt_text} class={format!("avatar {}", size_class)} src={src} />
        }
        .into_any();
    }

    let initials = initials_of(&name);
    view! {
        <span
            aria-hidden="true"
            class={format!("avatar avatar-placeholder {}", size_class)}
        >
            {initials}
        </span>
    }
    .into_any()
}
