-- Pandoc Lua filter: apply CSS styles based on custom-style attribute.
-- Requires: -f docx+styles (so pandoc preserves style names)
-- Reads STYLE_MAP_PATH env var pointing to a JSON file with:
--   { "bodyFont": "...", "styles": { "stylename": "css string", ... }, "headingStyles": {...} }

local style_map = nil
local body_font = nil
local heading_styles = nil

-- Load style map
local path = os.getenv("STYLE_MAP_PATH")
if path then
  local f = io.open(path, "r")
  if f then
    local content = f:read("*a")
    f:close()
    local ok, data = pcall(pandoc.json.decode, content)
    if ok and type(data) == "table" then
      style_map = data.styles or {}
      body_font = data.bodyFont
      heading_styles = data.headingStyles or {}
    end
  end
end

-- Apply style to a Div with custom-style (wraps styled paragraphs in docx+styles mode)
function Div(el)
  if not style_map then return el end

  local cs = el.attr.attributes["custom-style"]
  if not cs then return el end

  -- Skip TOC styles and heading styles (headings handled by Header function)
  if cs:lower():match("^toc") then return el end
  if cs:lower():match("^heading%s*%d") then return el end

  local css = style_map[cs:lower()]
  if not css or css == "" then return el end

  -- Apply the style to the inner block elements
  local new_blocks = {}
  for _, block in ipairs(el.content) do
    if block.t == "Para" then
      -- Convert to raw HTML with style
      local inner_doc = pandoc.Pandoc({block})
      local html = pandoc.write(inner_doc, "html")
      local inner = html:match("<p>(.-)</p>") or html:gsub("^%s*<p[^>]*>", ""):gsub("</p>%s*$", "")
      table.insert(new_blocks, pandoc.RawBlock("html", '<p style="' .. css .. '">' .. inner .. '</p>'))
    else
      table.insert(new_blocks, block)
    end
  end

  return new_blocks
end

-- Apply only text-align to headers (font handled by CSS stylesheet)
function Header(el)
  if not heading_styles then return el end

  local level_name = "heading " .. el.level
  local css = heading_styles[level_name]
  if not css or css == "" then return el end

  -- Only extract text-align from the full CSS
  local align = css:match("text%-align:%s*(%w+)")
  if align then
    el.attributes["style"] = "text-align: " .. align
  end
  return el
end
