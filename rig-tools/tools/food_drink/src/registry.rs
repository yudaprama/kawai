//! Registry: name → typed tool constructor.

use rig::tool::ToolSet;

/// Reports whether `name` has a native implementation in this crate.
pub fn is_native(name: &str) -> bool {
    matches!(
        name,
        "get_cocktails_by_ingredient"
            | "get_food_by_barcode"
            | "get_random_cocktail"
            | "get_random_recipe"
            | "get_recipes_by_ingredient"
            | "list_recipe_categories"
            | "search_cocktail"
            | "search_food_products"
            | "search_recipe"
    )
}

/// All native tool names in this crate, sorted.
pub fn native_names() -> Vec<&'static str> {
    vec![
        "get_cocktails_by_ingredient",
        "get_food_by_barcode",
        "get_random_cocktail",
        "get_random_recipe",
        "get_recipes_by_ingredient",
        "list_recipe_categories",
        "search_cocktail",
        "search_food_products",
        "search_recipe",
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
            "get_cocktails_by_ingredient" => {
                set.add_tool(GetCocktailsByIngredientTool::default());
            }
            "get_food_by_barcode" => {
                set.add_tool(GetFoodByBarcodeTool::default());
            }
            "get_random_cocktail" => {
                set.add_tool(GetRandomCocktailTool::default());
            }
            "get_random_recipe" => {
                set.add_tool(GetRandomRecipeTool::default());
            }
            "get_recipes_by_ingredient" => {
                set.add_tool(GetRecipesByIngredientTool::default());
            }
            "list_recipe_categories" => {
                set.add_tool(ListRecipeCategoriesTool::default());
            }
            "search_cocktail" => {
                set.add_tool(SearchCocktailTool::default());
            }
            "search_food_products" => {
                set.add_tool(SearchFoodProductsTool::default());
            }
            "search_recipe" => {
                set.add_tool(SearchRecipeTool::default());
            }
            other => panic!("rig-tools: unknown native tool {other:?}"),
        }
    }
    set
}
