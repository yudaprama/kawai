//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "get_anime_detail"
            | "get_book_by_isbn"
            | "get_curated_photos"
            | "get_random_poem"
            | "get_recommendations"
            | "get_seasonal_anime"
            | "get_top_anime"
            | "get_top_manga"
            | "get_tv_schedule"
            | "get_tv_show_detail"
            | "get_tv_show_seasons"
            | "search_album"
            | "search_anime"
            | "search_artist"
            | "search_books"
            | "search_manga"
            | "search_photos"
            | "search_poems_by_author"
            | "search_poems_by_title"
            | "search_tv_show"
            | "search_videos"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "get_anime_detail",
        "get_book_by_isbn",
        "get_curated_photos",
        "get_random_poem",
        "get_recommendations",
        "get_seasonal_anime",
        "get_top_anime",
        "get_top_manga",
        "get_tv_schedule",
        "get_tv_show_detail",
        "get_tv_show_seasons",
        "search_album",
        "search_anime",
        "search_artist",
        "search_books",
        "search_manga",
        "search_photos",
        "search_poems_by_author",
        "search_poems_by_title",
        "search_tv_show",
        "search_videos",
    ]
}

/// Build a `ToolSet` containing every native tool.
pub fn all_tools() -> ToolSet {
    toolset_for(&native_names())
}

/// Build a `ToolSet` for the given subset of native tool names.
/// Panics on unknown names (validate with [`is_native`] first).
pub fn toolset_for(names: &[&str]) -> ToolSet {
    use crate::generated::*;
    let mut set = ToolSet::default();
    for name in names {
        match *name {
            "get_anime_detail" => {
                set.add_tool(GetAnimeDetailTool::default());
            }
            "get_book_by_isbn" => {
                set.add_tool(GetBookByIsbnTool::default());
            }
            "get_curated_photos" => {
                set.add_tool(GetCuratedPhotosTool::default());
            }
            "get_random_poem" => {
                set.add_tool(GetRandomPoemTool::default());
            }
            "get_recommendations" => {
                set.add_tool(GetRecommendationsTool::default());
            }
            "get_seasonal_anime" => {
                set.add_tool(GetSeasonalAnimeTool::default());
            }
            "get_top_anime" => {
                set.add_tool(GetTopAnimeTool::default());
            }
            "get_top_manga" => {
                set.add_tool(GetTopMangaTool::default());
            }
            "get_tv_schedule" => {
                set.add_tool(GetTvScheduleTool::default());
            }
            "get_tv_show_detail" => {
                set.add_tool(GetTvShowDetailTool::default());
            }
            "get_tv_show_seasons" => {
                set.add_tool(GetTvShowSeasonsTool::default());
            }
            "search_album" => {
                set.add_tool(SearchAlbumTool::default());
            }
            "search_anime" => {
                set.add_tool(SearchAnimeTool::default());
            }
            "search_artist" => {
                set.add_tool(SearchArtistTool::default());
            }
            "search_books" => {
                set.add_tool(SearchBooksTool::default());
            }
            "search_manga" => {
                set.add_tool(SearchMangaTool::default());
            }
            "search_photos" => {
                set.add_tool(SearchPhotosTool::default());
            }
            "search_poems_by_author" => {
                set.add_tool(SearchPoemsByAuthorTool::default());
            }
            "search_poems_by_title" => {
                set.add_tool(SearchPoemsByTitleTool::default());
            }
            "search_tv_show" => {
                set.add_tool(SearchTvShowTool::default());
            }
            "search_videos" => {
                set.add_tool(SearchVideosTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
