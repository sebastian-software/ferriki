program Orders;
{$mode delphi}{$H+}
uses SysUtils, Generics.Collections;

type
  TOrder = record
    Customer: string;
    Cents: Int64;
    Completed: Boolean;
  end;

{ Aggregate completed orders; currency is stored as integer cents. }
function Summarize(const Values: array of TOrder): TDictionary<string, Int64>;
var
  Item: TOrder;
  Previous: Int64;
begin
  Result := TDictionary<string, Int64>.Create;
  for Item in Values do
    if Item.Completed and (Item.Cents >= 0) then
    begin
      if not Result.TryGetValue(Item.Customer, Previous) then Previous := 0;
      Result.AddOrSetValue(Item.Customer, Previous + Item.Cents);
    end;
end;

var
  Values: array[0..1] of TOrder;
  Totals: TDictionary<string, Int64>;
  Pair: TPair<string, Int64>;
begin
  Values[0].Customer := 'Ada'; Values[0].Cents := 1995; Values[0].Completed := True;
  Values[1].Customer := 'Zoë'; Values[1].Cents := 1250; Values[1].Completed := True;
  Totals := Summarize(Values);
  try
    for Pair in Totals do
      WriteLn(Format('<total customer="%s">%d cents</total>', [Pair.Key, Pair.Value]));
  finally
    Totals.Free;
  end;
end.
