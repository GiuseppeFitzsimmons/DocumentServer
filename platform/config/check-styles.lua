local count = 0

function Header(el)
  count = count + 1
  if count <= 35 then
    local cs = el.attr and el.attr.attributes and el.attr.attributes["custom-style"] or "NONE"
    local text = pandoc.utils.stringify(el):sub(1, 40)
    io.stderr:write("H" .. el.level .. " #" .. count .. " cs=\"" .. cs .. "\" \"" .. text .. "\"\n")
  end
  return el
end

function Div(el)
  count = count + 1
  local cs = el.attr.attributes["custom-style"] or nil
  if cs and count <= 35 then
    local text = pandoc.utils.stringify(el):sub(1, 40)
    io.stderr:write("Div #" .. count .. " cs=\"" .. cs .. "\" \"" .. text .. "\"\n")
  end
  return el
end

function Para(el)
  count = count + 1
  if count <= 35 then
    local text = pandoc.utils.stringify(el):sub(1, 40)
    io.stderr:write("Para #" .. count .. " \"" .. text .. "\"\n")
  end
  return el
end
