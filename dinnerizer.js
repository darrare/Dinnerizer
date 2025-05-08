$(document).ready(async function () {
  const API_BASE = "https://dinnerizer-backend-production.up.railway.app";
  const selectedRecipes = new Set();
  let selectedStoreId = null;
  let filteredRecipes = [];
  let latitude = null;
  let longitude = null;

  watchUserLocation();

  // Load recipes and initialize the display
  $.getJSON("recipes.json", function (recipes) {
    window._recipes = recipes;
    filteredRecipes = [...recipes];
    renderRecipes();
  });

  // Filter recipes based on search input and dietary restrictions
  $("#recipeSearch").on("input", function () {
    applyFilters();
  });

  $("#vegetarian, #glutenFree, #dairyFree").on("change", function () {
    applyFilters();
  });

  function applyFilters() {
    const searchTerm = $("#recipeSearch").val().toLowerCase();
    const selectedDietaryRestrictions = $(".dietaryFilters input:checked").map(function () {
      return $(this).attr("id");
    }).get();

    filteredRecipes.forEach((recipe, idx) => {
      const card = $(`[data-index="${idx}"]`);

      const matchesSearch = recipe.name.toLowerCase().includes(searchTerm) ||
        recipe.description.toLowerCase().includes(searchTerm) ||
        recipe.ingredients.some(ingredient => ingredient.name.toLowerCase().includes(searchTerm));

      const matchesDietaryRestrictions = selectedDietaryRestrictions.every(restriction => {
        return recipe.dietaryRestrictions && recipe.dietaryRestrictions.includes(restriction);
      });

      if (matchesSearch && (selectedDietaryRestrictions.length === 0 || matchesDietaryRestrictions)) {
        card.show();
      } else {
        card.hide();
      }
    });
  }

  function renderRecipes() {
    $("#recipes").empty();
    filteredRecipes.forEach((recipe, idx) => {
      const col = $('<div class="col-md-4 mb-3"></div>');
      const card = $(`  
        <div class="card recipe-card h-100" data-index="${idx}">
          <img src="${recipe.imageUrl}" class="card-img-top" alt="${recipe.name}" onerror="this.style.display='none'" />
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-center">
              <h5 class="card-title">${recipe.name}</h5>
              <span class="recipe-time text-muted">${recipe.time}</span>
            </div>
            <p class="card-text">${recipe.description}</p>
          </div>
        </div>
      `);
      card.on("click", function () {
        const i = $(this).data("index");
        if (selectedRecipes.has(i)) {
          selectedRecipes.delete(i);
          $(this).removeClass("selected");
        } else {
          selectedRecipes.add(i);
          $(this).addClass("selected");
        }
      });
      col.append(card);
      $("#recipes").append(col);
    });
  }

  function watchUserLocation() {
    if (navigator.geolocation) {
      navigator.geolocation.watchPosition(
        function (position) {
          latitude = position.coords.latitude;
          longitude = position.coords.longitude;
        },
        function (error) {
          console.error("Error fetching location:", error);
        },
        {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 10000
        }
      );

    } else {
      console.error("Geolocation is not supported by this browser.");
    }
  }

  // Store location and fetching ingredients logic
  $("#locateStores").on("click", () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
    }

    $("#storeList").empty().append(`<li class="list-group-item">Getting your location...</li>`);
    if (!latitude || !longitude) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          latitude = position.coords.latitude;
          longitude = position.coords.longitude;
        },
        (err) => {
          console.error(err);
          $("#storeList").html(`<li class="list-group-item text-danger">Unable to get your location.</li>`);
        }
      );
    }
    fetchStoresByCoords(latitude, longitude);

  });

  async function fetchStoresByCoords(lat, lng) {
    $("#storeList").empty().append(`<li class="list-group-item">Searching nearby stores...</li>`);

    try {
      const res = await fetch(`${API_BASE}/stores?lat=${lat}&lng=${lng}`);
      const data = await res.json();
      $("#storeList").empty();

      if (!data.data.length) {
        $("#storeList").append(`<li class="list-group-item">No stores found near you.</li>`);
        return;
      }

      data.data.forEach(store => {
        const item = $(`<li class="list-group-item">${store.name}</li>`);
        item.on("click", () => {
          selectedStoreId = store.locationId;
          $("#storeList .list-group-item").removeClass("selected-store");
          item.addClass("selected-store");
        });
        $("#storeList").append(item);
      });
    } catch (err) {
      console.error(err);
      $("#storeList").html(`<li class="list-group-item text-danger">Failed to fetch stores.</li>`);
    }
  }

  // Fetching ingredients and handling product search
  $("#fetchIngredients").on("click", async () => {
    if (!selectedStoreId) {
      alert("Please select a store first.");
      return;
    }

    const selectedIndices = Array.from(selectedRecipes);
    if (selectedIndices.length === 0) {
      alert("Please select at least one recipe.");
      return;
    }

    const ingredientMap = new Map();
    selectedIndices.forEach(idx => {
      window._recipes[idx].ingredients.forEach(ing => {
        const key = ing.name + "||" + ing.unit;
        const existing = ingredientMap.get(key);
        const amount = parseFloat(ing.amount);
        if (existing) {
          existing.amount += amount;
        } else {
          ingredientMap.set(key, {
            name: ing.name,
            unit: ing.unit,
            amount: amount
          });
        }
      });
    });

    $("#ingredientsList").html(`<div class="text-center">🔍 Searching Kroger...</div>`);

    try {
      const results = [];
      for (const [key, ing] of ingredientMap.entries()) {
        const data = await searchProducts(selectedStoreId, ing.name);
        results.push(data ?? { term: ing.name, locations: [], products: [] });
      }

      const grouped = groupIngredientsSmartly(results, ingredientMap);
      renderIngredients(grouped);
    } catch (err) {
      console.error(err);
      $("#ingredientsList").html(`<div class="text-danger">Failed to fetch products.</div>`);
    }
  });

  async function searchProducts(locationId, term) {
    try {
      const res = await fetch(`${API_BASE}/products?locationId=${locationId}&term=${encodeURIComponent(term)}`);
      const data = await res.json();
      if (!data.data) return null;
      const products = data.data.filter(p => p.aisleLocations?.length);
      return { term, products };
    } catch (err) {
      console.error(`Failed to fetch product: ${term}`, err);
      return null;
    }
  }

  function groupIngredientsSmartly(productResults, ingredientMap) {
    const aisleStats = {};
    const termToAisles = {};

    productResults.forEach(({ term, products }) => {
        const aisles = new Set();

        products.forEach(p => {
            p.aisleLocations.forEach(loc => {
                const aisle = loc.description?.toUpperCase().trim() || "OTHER";
                if (!aisleStats[aisle]) aisleStats[aisle] = 0;
                aisleStats[aisle]++;
                aisles.add(aisle);
            });
        });

        termToAisles[term] = Array.from(aisles);
    });

    const primaryAislePerTerm = {};
    for (const [term, aisles] of Object.entries(termToAisles)) {
        primaryAislePerTerm[term] = aisles.sort((a, b) => (aisleStats[b] || 0) - (aisleStats[a] || 0))[0] || "UNKNOWN";
    }

    const finalGrouped = {};
    for (const [key, ing] of ingredientMap.entries()) {
        const primaryAisle = primaryAislePerTerm[ing.name] || "UNKNOWN";
        const also = termToAisles[ing.name]?.filter(a => a !== primaryAisle) || [];

        const bayText = also.length ? ` (also in ${also.join(", ")})` : "";
        const line = `${capitalize(ing.name)} (${ing.amount}${ing.unit})${bayText}`;

        if (!finalGrouped[primaryAisle]) finalGrouped[primaryAisle] = [];
        finalGrouped[primaryAisle].push(line);
    }

    return finalGrouped;
}


function renderIngredients(groupedIngredients) {
  // Create the content for the ingredients list
  let output = '';
  for (const [aisle, ingredients] of Object.entries(groupedIngredients)) {
      output += `<strong>${aisle}</strong><ul>`;
      ingredients.forEach(item => {
          output += `<li>${item}</li>`;
      });
      output += `</ul>`;
  }

  // Insert the ingredients list into the container
  $("#ingredientsList").html(output || `<div class="text-center">No products found.</div>`);

  // Add the "Copy to clipboard" button outside of the content
  const copyButton = $('<button id="copyShoppingList" class="btn btn-primary">Copy to clipboard</button>');
  $("#ingredientsList").before(copyButton); // Place the button before the ingredients list

  // Copy the shopping list in #ingredientsList to clipboard in Markdown format
  $("#copyShoppingList").on("click", function () {
      let markdownContent = "";

      // Get the content inside #ingredientsList
      $("#ingredientsList").find("strong").each(function () {
          // Convert aisle name (strong tags) to Markdown bold format
          markdownContent += `**${$(this).text()}**\n`;

          // Find the corresponding list of ingredients and convert them to Markdown list items
          $(this).next("ul").find("li").each(function () {
              markdownContent += `- ${$(this).text()}\n`;
          });

          markdownContent += `\n`; // Add a newline between aisles
      });

      // Create a temporary textarea element to copy the text to clipboard
      const tempTextArea = document.createElement("textarea");
      tempTextArea.value = markdownContent;
      document.body.appendChild(tempTextArea);
      tempTextArea.select();
      document.execCommand("copy");
      document.body.removeChild(tempTextArea);

      alert("Shopping list copied to clipboard in Markdown format!");
  });
}
  
  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
});