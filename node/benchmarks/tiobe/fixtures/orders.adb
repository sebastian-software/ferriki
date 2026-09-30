with Ada.Text_IO; use Ada.Text_IO;
with Ada.Long_Long_Integer_Text_IO;

procedure Orders is
   subtype Cents is Long_Long_Integer range 0 .. Long_Long_Integer'Last;
   type Customer is (Ada, Zoe);
   type Order is record
      Name      : Customer;
      Amount    : Cents;
      Completed : Boolean := True;
   end record;
   type Order_List is array (Positive range <>) of Order;
   Values : constant Order_List :=
     ((Ada, 1995, True), (Zoe, 1250, True), (Ada, 500, False));

   -- A constrained array and checked integer arithmetic avoid currency drift.
   function Total_For (Items : Order_List; Name : Customer) return Cents is
      Total : Cents := 0;
   begin
      for Item of Items loop
         if Item.Completed and then Item.Name = Name then
            Total := Total + Item.Amount;
         end if;
      end loop;
      return Total;
   end Total_For;
begin
   for Name in Customer loop
      Put ("<total customer=""" & Customer'Image (Name) & """>");
      Ada.Long_Long_Integer_Text_IO.Put (Total_For (Values, Name), Width => 0);
      Put_Line (" cents</total>");
   end loop;
exception
   when Constraint_Error => Put_Line ("Currency amount exceeds the supported range");
end Orders;
